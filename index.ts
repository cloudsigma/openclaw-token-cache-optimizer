import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
	OpenClawPluginApi,
	ProviderResolveTransportTurnStateContext,
	ProviderTransportTurnState,
	ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/core"

/**
 * openclaw-taas-affinity
 *
 * Narrow CloudSigma TaaS provider hook for the post-requester-bridge Claude Code
 * lane. It only provides:
 * - stable affinity metadata (`metadata.session_id`, `metadata.sticky_key`)
 * - sanitized advisory requester runtime metadata
 * - `X-Session-Id` transport header injection
 * - TaaS autorouter response-header capture exposed through one gateway method
 *
 * Requester bridge leasing/polling/tool execution and OpenClaw run-maintenance
 * sidecars intentionally do not live in this plugin.
 */

const SESSION_ID_PREFIX = "oc:"
const REQUESTER_RUNTIME_SCHEMA_VERSION = "2026-06-04"
const REQUESTER_RUNTIME_SOURCE = "openclaw-taas-affinity"
const GIT_PROBE_TIMEOUT_MS = 250
const LAST_ROUTE_LIMIT = 256
const AUTOROUTER_OVERRIDE_LIMIT = 256
const PLUGIN_VERSION = "0.12.0"
const TRACE_BRIDGE_TTL_MS = 30 * 60 * 1000
const TRACE_BRIDGE_LIMIT = 1024
const AUTOROUTER_ALGORITHMS = new Set([
	"best_fit",
	"price_performance",
	"savings_curve",
	"cost",
	"ttft",
	"tps",
])

const isDev = process.env.NODE_ENV === "development" || Boolean(process.env.OPENCLAW_DEBUG)

type RequesterRuntime = Record<string, unknown>

type AutorouterCapture = {
	sessionId: string
	capturedAt: number
	taasRequestId: string | null
	taasTraceId: string | null
	openclawTurnId: string | null
	openclawAttempt: string | null
	autorouterModel: string | null
	autorouterAlgo: string | null
	autorouterAlgoSource: string | null
	thinkingApplied: string | null
	routedContextWindow: number | null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

type TraceBridgeDiagnostic = {
	runId?: string
	callId?: string
}

type TraceBridgeEntry = TraceBridgeDiagnostic & {
	sessionId: string | null
	ambiguous: boolean
	expiresAt: number
}

type TraceBridgeStats = {
	hit: number
	miss: number
	expired: number
	ambiguous: number
	directOptionsSessionId: number
}

const traceBridgeStats: TraceBridgeStats = {
	hit: 0,
	miss: 0,
	expired: 0,
	ambiguous: 0,
	directOptionsSessionId: 0,
}

function resetTraceBridgeStats(): void {
	for (const key of Object.keys(traceBridgeStats) as Array<keyof TraceBridgeStats>) {
		traceBridgeStats[key] = 0
	}
}

/**
 * Short-lived, bounded correlation between OpenClaw's public model-call hook
 * and the later provider invocation. Entries are deliberately non-consuming:
 * a transport may retry or invoke multiple callbacks with the same exact span.
 */
class TraceSessionBridge {
	private readonly entries = new Map<string, TraceBridgeEntry>()
	private readonly limit: number
	private readonly ttlMs: number
	private readonly now: () => number

	constructor(
		limit = TRACE_BRIDGE_LIMIT,
		ttlMs = TRACE_BRIDGE_TTL_MS,
		now: () => number = Date.now,
	) {
		this.limit = limit
		this.ttlMs = ttlMs
		this.now = now
	}

	private pruneExpired(now = this.now()): void {
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(key)
		}
	}

	private enforceLimit(): void {
		while (this.entries.size > this.limit) {
			const oldest = this.entries.keys().next().value as string | undefined
			if (!oldest) return
			this.entries.delete(oldest)
		}
	}

	record(key: string, sessionId: string, diagnostic: TraceBridgeDiagnostic = {}): void {
		const now = this.now()
		this.pruneExpired(now)
		const existing = this.entries.get(key)
		const ambiguous = existing?.ambiguous === true ||
			(Boolean(existing?.sessionId) && existing?.sessionId !== sessionId)
		const entry: TraceBridgeEntry = {
			sessionId: ambiguous ? null : sessionId,
			ambiguous,
			expiresAt: now + this.ttlMs,
			...diagnostic,
		}
		this.entries.delete(key)
		this.entries.set(key, entry)
		this.enforceLimit()
	}

	markAmbiguous(key: string, diagnostic: TraceBridgeDiagnostic = {}): void {
		const now = this.now()
		this.pruneExpired(now)
		this.entries.delete(key)
		this.entries.set(key, {
			sessionId: null,
			ambiguous: true,
			expiresAt: now + this.ttlMs,
			...diagnostic,
		})
		this.enforceLimit()
	}

	resolve(key: string): string | undefined {
		const now = this.now()
		const entry = this.entries.get(key)
		if (!entry) {
			traceBridgeStats.miss += 1
			this.pruneExpired(now)
			return undefined
		}
		if (entry.expiresAt <= now) {
			this.entries.delete(key)
			traceBridgeStats.expired += 1
			this.pruneExpired(now)
			return undefined
		}
		if (entry.ambiguous || !entry.sessionId) {
			traceBridgeStats.ambiguous += 1
			return undefined
		}

		// Successful exact correlation refreshes the handoff window. Keep the
		// entry non-consuming so delayed retries and concurrent provider calls do
		// not race, while moving it to the newest position for bounded eviction.
		entry.expiresAt = now + this.ttlMs
		this.entries.delete(key)
		this.entries.set(key, entry)
		traceBridgeStats.hit += 1
		return entry.sessionId
	}

	clear(resetStats = true): void {
		this.entries.clear()
		if (resetStats) resetTraceBridgeStats()
	}

	get stats(): Readonly<TraceBridgeStats> {
		return { ...traceBridgeStats }
	}

	get ttlMsValue(): number {
		return this.ttlMs
	}

	get limitValue(): number {
		return this.limit
	}

	get size(): number {
		this.pruneExpired()
		return this.entries.size
	}
}

const traceSessionBridge = new TraceSessionBridge()

function isNonZeroHex(value: string): boolean {
	return /[1-9a-f]/i.test(value)
}

function traceKeyFromContext(value: unknown): string | undefined {
	const trace = asRecord(value)
	const traceId = safeString(trace?.traceId)?.toLowerCase()
	const spanId = safeString(trace?.spanId)?.toLowerCase()
	if (!traceId || !/^[0-9a-f]{32}$/.test(traceId) || !isNonZeroHex(traceId)) return undefined
	if (!spanId || !/^[0-9a-f]{16}$/.test(spanId) || !isNonZeroHex(spanId)) return undefined
	return `${traceId}:${spanId}`
}

function traceKeyFromTraceparent(value: unknown): string | undefined {
	const traceparent = safeString(value)
	if (!traceparent) return undefined
	// OpenClaw currently emits canonical W3C version 00. Reject extensions and
	// malformed/future forms rather than risk a weak or ambiguous correlation.
	const match = /^00-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$/.exec(traceparent)
	if (!match) return undefined
	return traceKeyFromContext({ traceId: match[1], spanId: match[2] })
}

function traceKeyFromHeaders(value: unknown): string | undefined {
	const headers = asRecord(value)
	if (!headers) return undefined
	let candidate: string | undefined
	for (const [name, raw] of Object.entries(headers)) {
		if (name.toLowerCase() !== "traceparent") continue
		if (typeof raw !== "string") return undefined
		const normalized = raw.trim().toLowerCase()
		if (candidate !== undefined && candidate !== normalized) return undefined
		candidate = normalized
	}
	return traceKeyFromTraceparent(candidate)
}

function recordModelCallStarted(event: unknown, ctx: unknown): void {
	const eventRecord = asRecord(event)
	const ctxRecord = asRecord(ctx)
	const traceKey = traceKeyFromContext(ctxRecord?.trace)
	if (!traceKey) return

	// ctx.sessionId is the authoritative logical-session field in the public
	// lifecycle contract. event.sessionId is checked only for consistency; it
	// must never substitute for a missing authoritative context identity.
	const contextSessionId = safeString(ctxRecord?.sessionId)
	if (!contextSessionId) return
	const eventSessionId = safeString(eventRecord?.sessionId)

	const diagnostic = {
		runId: safeString(ctxRecord?.runId) ?? safeString(eventRecord?.runId),
		callId: safeString(eventRecord?.callId),
	}
	if (eventSessionId && eventSessionId !== contextSessionId) {
		traceSessionBridge.markAmbiguous(traceKey, diagnostic)
		return
	}
	traceSessionBridge.record(traceKey, contextSessionId, diagnostic)
}

function registerTraceSessionBridgeHook(api: OpenClawPluginApi): boolean {
	const on = (api as unknown as { on?: unknown }).on
	if (typeof on !== "function") return false
	try {
		;(on as (name: string, handler: (event: unknown, ctx: unknown) => void) => void).call(
			api,
			"model_call_started",
			recordModelCallStarted,
		)
		return true
	} catch {
		// Older runtimes may expose api.on without this lifecycle hook. Direct
		// options.sessionId/ctx.sessionId affinity remains fully functional.
		return false
	}
}

function stableHash(value: string, prefix: string, length = 16): string {
	const hex = createHash("sha256").update(value, "utf8").digest("hex")
	return `${prefix}:${hex.slice(0, length)}`
}

function deriveFallbackSessionId(source: string): string {
	const hex = createHash("sha256").update(source, "utf8").digest("hex")
	return `${SESSION_ID_PREFIX}${hex.slice(0, 16)}`
}

type ResolvedSessionIdentity = {
	sessionId: string
	source: string
	sourceHint: string
	localSessionScoped: boolean
	identityMode: "native" | "trace_bridge" | "legacy_env"
}

/**
 * Resolve only authoritative per-conversation identities. Provider invocation
 * options win, followed by wrapper context, exact trace/span correlation, and
 * finally the explicit legacy environment compatibility value.
 */
function resolveSessionIdentity(
	workspaceDirFromCtx?: string,
	sessionIdFromOptions?: unknown,
	sessionIdFromCtx?: unknown,
	sessionIdFromTrace?: unknown,
	agentIdFromCtx?: unknown,
): ResolvedSessionIdentity | null {
	const sourceHint = workspaceDirFromCtx
		? `workspaceDir:${workspaceDirFromCtx}`
		: `stateDir:${process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw")}`
	const candidates = [
		{ value: sessionIdFromOptions, source: "openclaw:options.sessionId", identityMode: "native" as const },
		{ value: sessionIdFromCtx, source: "openclaw:ctx.sessionId", identityMode: "native" as const },
		{ value: sessionIdFromTrace, source: "openclaw:model_call_started.trace", identityMode: "trace_bridge" as const },
	]
	for (const candidate of candidates) {
		const sessionId = safeString(candidate.value)
		if (sessionId) {
			return {
				sessionId,
				source: candidate.source,
				sourceHint,
				localSessionScoped: true,
				identityMode: candidate.identityMode,
			}
		}
	}

	const legacySessionId = safeString(process.env.OPENCLAW_SESSION_ID)
	if (legacySessionId) {
		return {
			sessionId: deriveFallbackSessionId(`legacy-env:${legacySessionId}`),
			source: "openclaw:env.OPENCLAW_SESSION_ID",
			sourceHint,
			localSessionScoped: true,
			identityMode: "legacy_env",
		}
	}

	// Agent and workspace scopes outlive conversations and are never identity
	// fallbacks. Keep the parameter only for compatibility with existing callers.
	void agentIdFromCtx
	return null
}

function findRepoRoot(startDir?: string): string | undefined {
	if (!startDir) return undefined
	let current = path.resolve(startDir)
	for (;;) {
		if (fs.existsSync(path.join(current, ".git"))) return current
		const parent = path.dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

function boundedGit(repoRoot: string, args: string[]): string | undefined {
	try {
		const output = execFileSync("git", ["-C", repoRoot, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_PROBE_TIMEOUT_MS,
			maxBuffer: 8 * 1024,
		})
		return output.trim() || undefined
	} catch {
		return undefined
	}
}

function readGitHeadBranch(repoRoot?: string): string | undefined {
	if (!repoRoot) return undefined
	const gitHead = boundedGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
	if (gitHead && gitHead !== "HEAD") return gitHead.slice(0, 120)

	try {
		const head = fs.readFileSync(path.join(repoRoot, ".git", "HEAD"), "utf8").trim()
		const match = /^ref: refs\/heads\/(.+)$/.exec(head)
		return match?.[1]?.slice(0, 120)
	} catch {
		return undefined
	}
}

function readGitDirtyHint(repoRoot?: string): boolean | undefined {
	if (!repoRoot) return undefined
	const status = boundedGit(repoRoot, ["status", "--porcelain", "--untracked-files=no"])
	if (status === undefined) return undefined
	return status.length > 0
}

function deriveAgentIdForCapture(ctx: { agentDir?: string; workspaceDir?: string }): string | null {
	const envAgent = process.env.OPENCLAW_AGENT_ID ?? process.env.OPENCLAW_RUN_ID
	if (envAgent && envAgent.trim()) return envAgent.trim()
	const base = ctx.agentDir ?? ctx.workspaceDir
	if (!base) return null
	const seg = path.basename(path.resolve(base))
	if (!seg) return null
	if (seg === "workspace") return "main"
	if (seg.startsWith("workspace-")) return seg.slice("workspace-".length)
	return seg
}

/**
 * Agent identity for the correlation envelope.
 *
 * TaaS requires BOTH an agent id and a session id before it will trust a
 * caller-supplied identity (`identity_present = session_present && agent_present`).
 * When neither is usable it discards the identity and mints a fresh session per
 * request, which silently destroys affinity and prompt-cache reuse.
 *
 * Directory/env derivation is best-effort and frequently unavailable, so fall
 * back to the agent segment encoded in OpenClaw session keys
 * (`agent:<agentId>:<scope>`) and finally to a stable literal. The value only
 * needs to be stable for the conversation, never globally unique.
 */
function resolveAgentIdentity(
	ctx: { agentDir?: string; workspaceDir?: string },
	sessionId: string | null | undefined
): string | null {
	const derived = deriveAgentIdForCapture(ctx)
	if (derived) return derived
	const sid = safeString(sessionId)
	if (sid) {
		const match = /^agent:([^:]+):/.exec(sid)
		if (match?.[1]) return match[1]
		return "main"
	}
	return null
}

function buildCorrelationMetadata(
	sessionId: string,
	source: string,
	sourceHint: string,
	ctx: ProviderWrapStreamFnContext,
	agentId: string | null
): Record<string, unknown> {
	const ctxRecord = ctx as unknown as Record<string, unknown>
	const modelRecord = asRecord(ctxRecord.model)
	const modelId = safeString(ctxRecord.modelId) ?? safeString(modelRecord?.id)
	const provider = safeString(ctxRecord.provider)
	return {
		schema_version: "2026-06-05",
		source: REQUESTER_RUNTIME_SOURCE,
		plugin_version: PLUGIN_VERSION,
		session_id: sessionId,
		sticky_key: sessionId,
		session_source_hint: stableHash(sourceHint, "source"),
		session_identity_scope: source === "openclaw:env.OPENCLAW_SESSION_ID" ? "legacy_generated_session" : "native_openclaw_session",
		...(agentId && { agent_id: agentId }),
		...(provider && { provider }),
		...(modelId && { model_id: modelId }),
	}
}

function buildCorrelationHeaders(args: {
	sessionId: string
	turnId?: unknown
	attempt?: unknown
	agentId?: string | null
}): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Session-Id": args.sessionId,
		"X-OpenClaw-Session-Id": args.sessionId,
		"X-OpenClaw-Plugin-Version": PLUGIN_VERSION,
	}
	const turnId = safeString(args.turnId)
	const attempt = args.attempt === undefined || args.attempt === null ? undefined : String(args.attempt)
	const agentId = safeString(args.agentId)
	if (turnId) headers["X-OpenClaw-Turn-Id"] = turnId
	if (attempt) headers["X-OpenClaw-Attempt"] = attempt
	if (agentId) headers["X-OpenClaw-Agent-Id"] = agentId
	return headers
}

function buildRequesterRuntime(
	ctx: ProviderWrapStreamFnContext,
	sessionId: string,
	source: string,
	sourceHint: string
): RequesterRuntime {
	const ctxRecord = ctx as unknown as Record<string, unknown>
	const modelRecord = asRecord(ctxRecord.model)
	const workspaceDir = safeString(ctx.workspaceDir)
	const repoRoot = findRepoRoot(workspaceDir)
	const modelId = safeString(ctxRecord.modelId) ?? safeString(modelRecord?.id)
	const provider = safeString(ctxRecord.provider)

	return {
		schema_version: REQUESTER_RUNTIME_SCHEMA_VERSION,
		source: REQUESTER_RUNTIME_SOURCE,
		session_key: sessionId,
		openclaw_session_id: sessionId,
		requester_host_id: stableHash(os.hostname(), "host"),
		...(repoRoot && { repo_name: path.basename(repoRoot) }),
		...(repoRoot && { git_branch_hint: readGitHeadBranch(repoRoot) }),
		...(repoRoot && { git_dirty_hint: readGitDirtyHint(repoRoot) }),
		...(provider && { provider }),
		...(modelId && { model_id: modelId }),
		session_source_hint: stableHash(sourceHint, "source"),
		session_identity_scope: source === "openclaw:env.OPENCLAW_SESSION_ID" ? "legacy_generated_session" : "native_openclaw_session",
		tool_execution: "direction_2_gateway",
		metadata_classification: {
			identifiers: "hashed",
			repository: "name_branch_dirty_only",
			local_paths: "omitted_by_default",
		},
		redaction_policy: "no_secrets;no_raw_local_paths;no_env_values;no_git_remotes;no_status_or_diffs;no_extra_params",
	}
}

function patchPayloadMetadata(
	payload: Record<string, unknown>,
	sessionId: string,
	requesterRuntime?: RequesterRuntime,
	correlation?: Record<string, unknown>,
	injectAffinityMetadata = true
): Record<string, unknown> {
	const existingMeta = asRecord(payload.metadata) ?? {}
	const needsSessionId = injectAffinityMetadata && !existingMeta.session_id
	const needsStickyKey = injectAffinityMetadata && !existingMeta.sticky_key
	const needsRequesterRuntime = requesterRuntime && !existingMeta.requester_runtime
	const needsCorrelation = correlation && !existingMeta.openclaw_correlation
	if (!needsSessionId && !needsStickyKey && !needsRequesterRuntime && !needsCorrelation) return payload
	return {
		...payload,
		metadata: {
			...existingMeta,
			...(needsSessionId && { session_id: sessionId }),
			...(needsStickyKey && { sticky_key: sessionId }),
			...(needsRequesterRuntime && { requester_runtime: requesterRuntime }),
			...(needsCorrelation && { openclaw_correlation: correlation }),
		},
	}
}

const lastRouteBySessionId = new Map<string, AutorouterCapture>()
const lastRouteByAgentId = new Map<string, AutorouterCapture>()
const autorouterAlgorithmBySessionId = new Map<string, string>()

function setAutorouterAlgorithm(sessionId: string, algorithm: string | null): void {
	autorouterAlgorithmBySessionId.delete(sessionId)
	if (algorithm === null) return
	autorouterAlgorithmBySessionId.set(sessionId, algorithm)
	while (autorouterAlgorithmBySessionId.size > AUTOROUTER_OVERRIDE_LIMIT) {
		const oldest = autorouterAlgorithmBySessionId.keys().next().value as string | undefined
		if (!oldest) break
		autorouterAlgorithmBySessionId.delete(oldest)
	}
}

function getAutorouterAlgorithm(sessionId: string): string | undefined {
	const algorithm = autorouterAlgorithmBySessionId.get(sessionId)
	if (!algorithm) return undefined
	// Refresh insertion order so active sessions survive bounded eviction.
	autorouterAlgorithmBySessionId.delete(sessionId)
	autorouterAlgorithmBySessionId.set(sessionId, algorithm)
	return algorithm
}

function pruneLastRouteMap(): void {
	if (lastRouteBySessionId.size > LAST_ROUTE_LIMIT) {
		const entries = [...lastRouteBySessionId.entries()].sort(
			(a, b) => a[1].capturedAt - b[1].capturedAt
		)
		for (let i = 0; i < entries.length - LAST_ROUTE_LIMIT; i++) {
			lastRouteBySessionId.delete(entries[i][0])
		}
	}
	if (lastRouteByAgentId.size > LAST_ROUTE_LIMIT) {
		const entries = [...lastRouteByAgentId.entries()].sort(
			(a, b) => a[1].capturedAt - b[1].capturedAt
		)
		for (let i = 0; i < entries.length - LAST_ROUTE_LIMIT; i++) {
			lastRouteByAgentId.delete(entries[i][0])
		}
	}
}

function captureAutorouterFromHeaders(
	sessionId: string,
	headers: Record<string, string>,
	agentId: string | null
): void {
	const lowered: Record<string, string> = {}
	for (const [k, v] of Object.entries(headers)) {
		if (typeof v === "string") lowered[k.toLowerCase()] = v
	}
	if (lowered["x-taas-autorouted"] !== "true") return

	const rawContextWindow = lowered["x-taas-routed-context-window"]
	const parsedContextWindow = rawContextWindow ? Number(rawContextWindow) : null
	const capture: AutorouterCapture = {
		sessionId,
		capturedAt: Date.now(),
		autorouterModel: lowered["x-taas-autorouter-model"] ?? null,
		autorouterAlgo: lowered["x-taas-autorouter-mode"] ?? null,
		autorouterAlgoSource: lowered["x-taas-autorouter-algorithm-source"] ?? null,
		taasRequestId: lowered["x-request-id"] ?? lowered["x-taas-request-id"] ?? null,
		taasTraceId: lowered["x-trace-id"] ?? lowered["x-taas-trace-id"] ?? null,
		openclawTurnId: lowered["x-openclaw-turn-id"] ?? null,
		openclawAttempt: lowered["x-openclaw-attempt"] ?? null,
		thinkingApplied: lowered["x-taas-thinking-applied"] ?? null,
		routedContextWindow:
			parsedContextWindow && Number.isFinite(parsedContextWindow) && parsedContextWindow > 0
				? parsedContextWindow
				: null,
	}

	lastRouteBySessionId.set(sessionId, capture)
	if (agentId) lastRouteByAgentId.set(agentId, capture)
	pruneLastRouteMap()

	if (isDev) {
		console.debug(
			`[taas-affinity] captured autorouter identityRef=${stableHash(sessionId, "session")} ` +
				`model=${capture.autorouterModel} algo=${capture.autorouterAlgo} ` +
				`source=${capture.autorouterAlgoSource} thinking=${capture.thinkingApplied} ` +
				`ctxWindow=${capture.routedContextWindow}`
		)
	}
}

function getLastRouteForSession(sessionId: string): AutorouterCapture | null {
	return lastRouteBySessionId.get(sessionId) ?? null
}

function getLastRouteForAgent(agentId: string): AutorouterCapture | null {
	return lastRouteByAgentId.get(agentId) ?? null
}

function buildWrapper(ctx: ProviderWrapStreamFnContext) {
	const { streamFn } = ctx
	if (!streamFn) return undefined

	const inner = streamFn
	return function taasAffinityStreamFn(...args: Parameters<typeof inner>) {
		const [model, context, options] = args
		const optionRecord = options as unknown as Record<string, unknown> | undefined
		const traceKey = traceKeyFromHeaders(optionRecord?.headers)
		const directOptionsSessionId = safeString(optionRecord?.sessionId)
		if (directOptionsSessionId) traceBridgeStats.directOptionsSessionId += 1
		let resolvedIdentity: ResolvedSessionIdentity | null | undefined
		const getIdentity = (): ResolvedSessionIdentity | null => {
			if (resolvedIdentity) return resolvedIdentity
			const bridgeSessionId = traceKey ? traceSessionBridge.resolve(traceKey) : undefined
			const identity = resolveSessionIdentity(
				ctx.workspaceDir,
				optionRecord?.sessionId,
				(ctx as { sessionId?: unknown }).sessionId,
				bridgeSessionId,
				(ctx as { agentId?: unknown }).agentId,
			)
			// Cache successful resolution in this invocation only. Leave misses
			// uncached because model_call_started is intentionally fire-and-forget
			// and may populate the exact trace bridge before payload construction.
			if (identity) resolvedIdentity = identity
			return identity
		}

		const prevOnPayload = options?.onPayload
		const onPayload: NonNullable<typeof options>["onPayload"] = async (payload, payloadModel) => {
			const payloadRecord = asRecord(payload)
			if (!payloadRecord) return prevOnPayload ? prevOnPayload(payload, payloadModel) : payload
			if (
				traceKey &&
				!safeString(optionRecord?.sessionId) &&
				!safeString((ctx as { sessionId?: unknown }).sessionId)
			) {
				// Core dispatches observational model-call hooks through a queued
				// microtask before invoking the provider stream. Yield once so the
				// synchronous hook handler can publish this exact trace mapping even
				// when a transport constructs its payload immediately. This does not
				// correlate by time: only the exact validated trace/span can resolve.
				await Promise.resolve()
			}
			const identity = getIdentity()
			if (!identity) return prevOnPayload ? prevOnPayload(payloadRecord, payloadModel) : payloadRecord
			const agentIdForCapture = resolveAgentIdentity(
				ctx as { agentDir?: string; workspaceDir?: string },
				identity.sessionId,
			)
			const requesterRuntime = buildRequesterRuntime(
				ctx,
				identity.sessionId,
				identity.source,
				identity.sourceHint,
			)
			const correlation = buildCorrelationMetadata(
				identity.sessionId,
				identity.source,
				identity.sourceHint,
				ctx,
				agentIdForCapture,
			)
			const patched = patchPayloadMetadata(
				payloadRecord,
				identity.sessionId,
				requesterRuntime,
				correlation,
				true,
			)
			if (isDev) {
				console.debug(
					`[taas-affinity] stream identityRef=${stableHash(identity.sessionId, "session")} mode=${identity.identityMode}`,
				)
			}
			return prevOnPayload ? prevOnPayload(patched, payloadModel) : patched
		}
		const prevOnResponse = options?.onResponse
		const onResponse: NonNullable<typeof options>["onResponse"] = async (response, responseModel) => {
			try {
				const identity = getIdentity()
				if (identity) {
					const agentIdForCapture = resolveAgentIdentity(
						ctx as { agentDir?: string; workspaceDir?: string },
						identity.sessionId,
					)
					captureAutorouterFromHeaders(identity.sessionId, response?.headers ?? {}, agentIdForCapture)
				}
			} catch (err) {
				if (isDev) console.debug(`[taas-affinity] onResponse capture failed: ${(err as Error)?.message ?? err}`)
			}
			if (prevOnResponse) await prevOnResponse(response, responseModel)
		}
		const identity = getIdentity()
		const autorouterAlgorithm = identity
			? getAutorouterAlgorithm(identity.sessionId)
			: undefined
		return inner(model, context, {
			...options,
			...(autorouterAlgorithm
				? {
					headers: {
						...options?.headers,
						"X-TaaS-Autorouter-Algorithm": autorouterAlgorithm,
					},
				}
				: {}),
			onPayload,
			onResponse,
		})
	} as typeof inner
}

function buildTransportTurnState(ctx: ProviderResolveTransportTurnStateContext): ProviderTransportTurnState | null {
	const identity = resolveSessionIdentity(
		undefined,
		(ctx as { sessionId?: unknown }).sessionId,
		undefined,
		undefined,
		(ctx as { agentId?: unknown }).agentId,
	)
	if (!identity) {
		if (isDev) console.debug("[taas-affinity] no strong session identity; skipping affinity headers")
		return null
	}
	const agentId = resolveAgentIdentity(
		ctx as unknown as { agentDir?: string; workspaceDir?: string },
		identity.sessionId
	)
	if (isDev) {
		console.debug(
			`[taas-affinity] resolveTransportTurnState identityRef=${stableHash(identity.sessionId, "session")} ` +
				`mode=${identity.identityMode} attempt=${ctx.attempt}`
		)
	}
	const headers = buildCorrelationHeaders({ sessionId: identity.sessionId, turnId: ctx.turnId, attempt: ctx.attempt, agentId })
	const autorouterAlgorithm = getAutorouterAlgorithm(identity.sessionId)
	if (autorouterAlgorithm) headers["X-TaaS-Autorouter-Algorithm"] = autorouterAlgorithm
	return { headers }
}

export default {
	// Internal helpers exposed strictly for unit tests. Not part of the plugin
	// contract and not used at runtime.
	__test__: {
		resolveSessionIdentity,
		resolveAgentIdentity,
		deriveAgentIdForCapture,
		buildCorrelationMetadata,
		buildCorrelationHeaders,
		TraceSessionBridge,
		traceKeyFromContext,
		traceKeyFromTraceparent,
		traceKeyFromHeaders,
		recordModelCallStarted,
		traceSessionBridge,
		traceBridgeStats,
		resetTraceBridgeStats,
		setAutorouterAlgorithm,
		getAutorouterAlgorithm,
		autorouterAlgorithmBySessionId,
	},
	id: "openclaw-taas-affinity",
	name: "CloudSigma TaaS Token Cache Optimizer",
	description:
		"Injects a stable per-conversation session ID into outbound LLM requests so TaaS can " +
		"pin sessions to the same upstream slot from turn 1, maximising prompt-cache hit rates.",

	register(api: OpenClawPluginApi) {
		registerTraceSessionBridgeHook(api)

		// The runtime supports wrapSimpleCompletionStreamFn, but the installed
		// plugin-sdk ProviderPlugin declaration lags that optional hook. Keep the
		// compatibility cast scoped to this registration object.
		api.registerProvider({
			id: "taas-affinity-hook",
			label: "CloudSigma TaaS Token Cache Optimizer",
			hookAliases: ["cloudsigma", "cloudsigma-staging"],
			auth: [],
			// Full agent/tool runs use wrapStreamFn. Internal/background/simple
			// completions use a separate OpenClaw hook; omitting it created a
			// second identity-less population on the same Snowcrash API key.
			// Both surfaces must inject identical session/sticky metadata.
			wrapStreamFn: buildWrapper,
			wrapSimpleCompletionStreamFn: buildWrapper,
			resolveTransportTurnState: buildTransportTurnState,
		} as any)

		if (typeof api.registerGatewayMethod === "function") api.registerGatewayMethod(
			"taas.completion.deliver",
			async ({ params, respond }) => {
				const pp = (params ?? {}) as Record<string, unknown>
				const sessionId = safeString(pp.sessionId)
				const operationId = safeString(pp.operationId)
				const output = safeString(pp.output)
				if (!sessionId || !operationId || !output) {
					respond(false, undefined, { code: "invalid_request", message: "sessionId, operationId, and output are required" })
					return
				}
				const eventText = [
					"[Requester bridge background completion]",
					`operation_id=${operationId}`,
					"The exact session-bound Claude Code continuation completed. Send the following completion update to the user in normal assistant voice:",
					output,
				].join("\n")
				const queued = api.runtime.system.enqueueSystemEvent(eventText, { sessionKey: sessionId })
				if (queued) api.runtime.system.requestHeartbeat({
					source: "other",
					intent: "immediate",
					reason: "taas_completion_delivery",
					sessionKey: sessionId,
				})
				respond(true, { ok: Boolean(queued), sessionId, operationId })
			},
			{ scope: "operator.write" }
		)

		if (typeof api.registerGatewayMethod === "function") api.registerGatewayMethod(
			"taas.affinity.stats",
			async ({ respond }) => {
				respond(true, {
					pluginVersion: PLUGIN_VERSION,
					bridge: {
						ttlMs: traceSessionBridge.ttlMsValue,
						limit: traceSessionBridge.limitValue,
						size: traceSessionBridge.size,
					},
					counters: traceSessionBridge.stats,
				})
			},
			{ scope: "operator.read" },
		)

		if (typeof api.registerGatewayMethod === "function") api.registerGatewayMethod(
			"taas.autorouter.setAlgorithm",
			async ({ params, respond }) => {
				const pp = (params ?? {}) as Record<string, unknown>
				const sessionId = safeString(pp.sessionId)
				if (!sessionId) {
					respond(false, undefined, { code: "invalid_request", message: "sessionId is required" })
					return
				}
				if (pp.algorithm !== null && typeof pp.algorithm !== "string") {
					respond(false, undefined, { code: "invalid_request", message: "algorithm must be a supported algorithm or null" })
					return
				}
				const algorithm = pp.algorithm === null ? null : safeString(pp.algorithm)
				if (algorithm !== null && (!algorithm || !AUTOROUTER_ALGORITHMS.has(algorithm))) {
					respond(false, undefined, {
						code: "invalid_request",
						message: "unsupported AutoRouter algorithm",
					})
					return
				}
				setAutorouterAlgorithm(sessionId, algorithm)
				respond(true, { ok: true, sessionId, algorithm })
			},
			{ scope: "operator.write" },
		)

		if (typeof api.registerGatewayMethod === "function") api.registerGatewayMethod(
			"taas.autorouter.lastRoute",
			async ({ params, respond }) => {
				const pp = (params ?? {}) as Record<string, unknown>
				const directAgentId = safeString(pp.agentId) ?? null
				const directSessionId = safeString(pp.sessionId) ?? null
				const workspaceDir = safeString(pp.workspaceDir)

				if (directAgentId) {
					const captured = getLastRouteForAgent(directAgentId)
					respond(true, {
						agentId: directAgentId,
						sessionId: captured?.sessionId ?? null,
						capture: captured,
					})
					return
				}

				const resolvedIdentity = directSessionId
					? null
					: resolveSessionIdentity(workspaceDir, safeString(pp.localSessionId), undefined, undefined, undefined)
				const resolvedSessionId = directSessionId ?? resolvedIdentity?.sessionId ?? null
				respond(true, {
					sessionId: resolvedSessionId,
					capture: resolvedSessionId ? getLastRouteForSession(resolvedSessionId) : null,
				})
			},
			{ scope: "operator.read" }
		)
	},

	_testExports: {
		buildRequesterRuntime,
		patchPayloadMetadata,
		resolveSessionIdentity,
		deriveFallbackSessionId,
		captureAutorouterFromHeaders,
		buildCorrelationHeaders,
		buildCorrelationMetadata,
		getLastRouteForAgent,
		getLastRouteForSession,
		TraceSessionBridge,
		traceKeyFromContext,
		traceKeyFromTraceparent,
		traceKeyFromHeaders,
		recordModelCallStarted,
		traceSessionBridge,
		traceBridgeStats,
		resetTraceBridgeStats,
		setAutorouterAlgorithm,
		getAutorouterAlgorithm,
		autorouterAlgorithmBySessionId,
	},
}

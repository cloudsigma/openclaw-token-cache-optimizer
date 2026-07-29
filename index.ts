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
const PLUGIN_VERSION = "0.10.0"

// OpenClaw stores active registry state (including workspaceDir) on globalThis
// under this well-known symbol key.
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState")
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
	identityMode: "native" | "legacy_env"
}

/**
 * Prefer OpenClaw's native conversation identity exactly as supplied by the
 * current provider runtime contract. Generation is retained only for older
 * runtimes that expose OPENCLAW_SESSION_ID but do not populate ctx.sessionId.
 *
 * We intentionally do not derive identity from workspace, agent, run, or state
 * paths: those scopes can outlive a conversation and accidentally join two
 * otherwise independent sessions in TaaS.
 */
function resolveSessionIdentity(
	workspaceDirFromCtx?: string,
	sessionIdFromCtx?: unknown,
	agentIdFromCtx?: unknown,
): ResolvedSessionIdentity | null {
	const nativeSessionId = safeString(sessionIdFromCtx)
	const sourceHint = workspaceDirFromCtx
		? `workspaceDir:${workspaceDirFromCtx}`
		: `stateDir:${process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw")}`

	if (nativeSessionId) {
		return {
			sessionId: nativeSessionId,
			source: "openclaw:ctx.sessionId",
			sourceHint,
			localSessionScoped: true,
			identityMode: "native",
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

	// Deliberately do not derive conversation identity from agentId or workspace.
	// Those scopes outlive individual sessions and would merge unrelated chats,
	// subprocesses, or workers onto one TaaS affinity key. Current OpenClaw runs
	// provide the authoritative identity per invocation through options.sessionId;
	// requests without native or explicit legacy identity remain identity-less.
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
		session_identity_scope: source === "openclaw:ctx.sessionId" ? "native_openclaw_session" : "legacy_generated_session",
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
		session_identity_scope: source === "openclaw:ctx.sessionId" ? "native_openclaw_session" : "legacy_generated_session",
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
			`[taas-affinity] captured autorouter sessionId=${sessionId} ` +
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
		// The provider wrapper is created before an embedded run is bound, so the
		// authoritative conversation identity lives on this invocation's stream
		// options. Resolve it here rather than once at wrapper construction time.
		// Keeping every derived value in this invocation closure also prevents two
		// concurrent sessions sharing a provider wrapper from contaminating one
		// another's payload metadata or response capture.
		const identity = resolveSessionIdentity(
			ctx.workspaceDir,
			(options as { sessionId?: unknown } | undefined)?.sessionId ??
				(ctx as { sessionId?: unknown }).sessionId,
			(ctx as { agentId?: unknown }).agentId,
		)
		// Resolve agent identity from the session key when no dir/env hint exists so
		// TaaS never falls back to minting its own per-request session id.
		const agentIdForCapture = resolveAgentIdentity(
			ctx as { agentDir?: string; workspaceDir?: string },
			identity?.sessionId,
		)
		const requesterRuntime = identity
			? buildRequesterRuntime(ctx, identity.sessionId, identity.source, identity.sourceHint)
			: undefined
		const correlation = identity
			? buildCorrelationMetadata(
					identity.sessionId,
					identity.source,
					identity.sourceHint,
					ctx,
					agentIdForCapture,
				)
			: undefined

		if (isDev) {
			console.debug(
				`[taas-affinity] stream invocation sessionId=${identity?.sessionId ?? "none"} mode=${identity?.identityMode ?? "none"}`,
			)
		}

		const prevOnPayload = options?.onPayload
		const onPayload: NonNullable<typeof options>["onPayload"] = async (payload, payloadModel) => {
			const payloadRecord = asRecord(payload)
			if (!payloadRecord) return prevOnPayload ? prevOnPayload(payload, payloadModel) : payload
			const patched = identity
				? patchPayloadMetadata(payloadRecord, identity.sessionId, requesterRuntime, correlation, true)
				: payloadRecord
			return prevOnPayload ? prevOnPayload(patched, payloadModel) : patched
		}
		const prevOnResponse = options?.onResponse
		const onResponse: NonNullable<typeof options>["onResponse"] = async (response, responseModel) => {
			try {
				identity && captureAutorouterFromHeaders(identity.sessionId, response?.headers ?? {}, agentIdForCapture)
			} catch (err) {
				if (isDev) console.debug(`[taas-affinity] onResponse capture failed: ${(err as Error)?.message ?? err}`)
			}
			if (prevOnResponse) await prevOnResponse(response, responseModel)
		}
		return inner(model, context, { ...options, onPayload, onResponse })
	} as typeof inner
}

function buildTransportTurnState(ctx: ProviderResolveTransportTurnStateContext): ProviderTransportTurnState | null {
	const identity = resolveSessionIdentity(
		undefined,
		(ctx as { sessionId?: unknown }).sessionId,
		(ctx as { agentId?: unknown }).agentId,
	)
	if (!identity) {
		if (isDev) console.debug(`[taas-affinity] no native or legacy session identity; skipping affinity headers turnId=${ctx.turnId}`)
		return null
	}
	const agentId = resolveAgentIdentity(
		ctx as unknown as { agentDir?: string; workspaceDir?: string },
		identity.sessionId
	)
	if (isDev) {
		console.debug(
			`[taas-affinity] resolveTransportTurnState sessionId=${identity.sessionId} ` +
				`mode=${identity.identityMode} turnId=${ctx.turnId} attempt=${ctx.attempt}`
		)
	}
	return { headers: buildCorrelationHeaders({ sessionId: identity.sessionId, turnId: ctx.turnId, attempt: ctx.attempt, agentId }) }
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
	},
	id: "openclaw-taas-affinity",
	name: "CloudSigma TaaS Token Cache Optimizer",
	description:
		"Injects a stable per-conversation session ID into outbound LLM requests so TaaS can " +
		"pin sessions to the same upstream slot from turn 1, maximising prompt-cache hit rates.",

	register(api: OpenClawPluginApi) {
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
					: resolveSessionIdentity(workspaceDir, safeString(pp.localSessionId))
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
	},
}

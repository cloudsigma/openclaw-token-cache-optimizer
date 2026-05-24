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
 * Injects a stable per-conversation session ID (oc:<sha256-prefix>) into every
 * outbound request to CloudSigma TaaS providers so the session-affinity layer
 * achieves confidence=1.0 from turn 1, maximising prompt-cache hit rates.
 *
 * For CloudSigma TaaS providers, the plugin also creates/refreshes a short
 * requester bridge lease and injects the returned opaque descriptor into
 * metadata.requester_runtime.available_bridges. Set
 * TAAS_REQUESTER_BRIDGE_PLUGIN_ENABLED=0 to disable this behaviour explicitly.
 * The bridge remains requester-authorized: TaaS is the relay/audit/transport
 * layer, while requester/plugin-side permissions decide actual tool execution.
 */

const SESSION_ID_PREFIX = "oc:"
const REQUESTER_RUNTIME_SCHEMA_VERSION = "2026-05-23"
const REQUESTER_RUNTIME_SOURCE = "openclaw-token-cache-optimizer"
const REQUESTER_BRIDGE_PLUGIN_FLAG = "TAAS_REQUESTER_BRIDGE_PLUGIN_ENABLED"
const DEFAULT_TAAS_BASE_URL = "https://taas.cloudsigma.com"
const REQUESTER_BRIDGE_LEASE_PATH = "/internal/requester-bridges/leases"
const REQUESTER_BRIDGE_POLL_PATH = "/internal/requester-bridges/poll"
const REQUESTER_BRIDGE_RESULTS_PATH = "/internal/requester-bridges/results"
const REQUESTER_BRIDGE_CAPABILITY = "requester.tool.invoke"
const REQUESTER_BRIDGE_CAPABILITY_LEGACY = "openclaw.tool.invoke"
const REQUESTER_BRIDGE_DEFAULT_TTL_SECONDS = 5 * 60
const GIT_PROBE_TIMEOUT_MS = 250
const LEASE_REQUEST_TIMEOUT_MS = 1200
const POLL_REQUEST_TIMEOUT_MS = 1200
const DEFAULT_POLL_INTERVAL_MS = 1000
const MAX_ECHO_BYTES = 4096

type RequesterRuntime = Record<string, unknown>

type RuntimeContextHints = {
	workspaceDir?: string
	agentDir?: string
	repoRoot?: string
	modelId?: string
	provider?: string
}

type LeaseResponse = {
	ok?: boolean
	descriptor?: unknown
	lease_id?: unknown
	bridge_id?: unknown
}

type BridgePollOperation = {
	operation_id?: unknown
	audit_id?: unknown
	lease_id?: unknown
	bridge_id?: unknown
	operation?: unknown
	arguments?: unknown
}

type PollerState = { timer?: NodeJS.Timeout; inFlight: boolean }

// OpenClaw stores the active registry state (including workspaceDir) on globalThis
// under this well-known symbol key.
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState")

const isDev =
	process.env.NODE_ENV === "development" || Boolean(process.env.OPENCLAW_DEBUG)

const activePollers = new Map<string, PollerState>()

function envFlagDisabled(name: string): boolean {
	return ["0", "false", "no", "off"].includes(
		(process.env[name] ?? "").trim().toLowerCase()
	)
}

function requesterBridgePluginEnabled(): boolean {
	return !envFlagDisabled(REQUESTER_BRIDGE_PLUGIN_FLAG)
}

/**
 * Resolves the best available session source string, working through the
 * fallback tier list. Returns undefined only when no source is found at all
 * (practically impossible — Tier 5 always produces a value via fallbackSessionId).
 *
 * Tier 1 is handled by the caller (ctx.workspaceDir) before reaching this.
 */
function getActiveSessionSource(): string | undefined {
	// Tier 3: explicit env var set by OpenClaw for sub-agents
	const envSessionId = process.env.OPENCLAW_SESSION_ID
	if (envSessionId) return `env:${envSessionId}`

	// Tier 4: stable per-agent env vars
	const envAgentId = process.env.OPENCLAW_AGENT_ID ?? process.env.OPENCLAW_RUN_ID
	if (envAgentId) return `agent:${envAgentId}`

	// Tier 2: workspace dir from plugin registry state (parent agent)
	const state = (globalThis as Record<symbol, unknown>)[PLUGIN_REGISTRY_STATE] as
		| { workspaceDir?: string }
		| null
		| undefined
	return state?.workspaceDir
}

function deriveSessionId(source: string): string {
	const normalised = source.startsWith("env:") || source.startsWith("agent:")
		? source // already a stable unique token, hash as-is
		: path.resolve(source)
	const hex = createHash("sha256").update(normalised, "utf8").digest("hex")
	return `${SESSION_ID_PREFIX}${hex.slice(0, 16)}`
}

function fallbackSessionId(): string {
	// Tier 5: stable per-installation but not per-session.
	// Uses the OpenClaw state dir as a last-resort stable source.
	const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw")
	return deriveSessionId(stateDir)
}

/**
 * Resolves the session ID, walking through Tiers 1–5 in order.
 * Returns both the derived ID and the source string used (for debug logging).
 */
function resolveSessionId(workspaceDirFromCtx?: string): {
	sessionId: string
	source: string
} {
	// Tier 1: explicit from wrapStreamFn context
	if (workspaceDirFromCtx) {
		return {
			sessionId: deriveSessionId(workspaceDirFromCtx),
			source: `workspaceDir:${workspaceDirFromCtx}`,
		}
	}

	// Tiers 2–4 via getActiveSessionSource()
	const activeSource = getActiveSessionSource()
	if (activeSource) {
		return {
			sessionId: deriveSessionId(activeSource),
			source: activeSource,
		}
	}

	// Tier 5 fallback
	const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw")
	return {
		sessionId: deriveSessionId(stateDir),
		source: `stateDir:${stateDir}`,
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function stableHash(value: string, prefix: string, length = 16): string {
	const hex = createHash("sha256").update(value, "utf8").digest("hex")
	return `${prefix}:${hex.slice(0, length)}`
}

function resolveWorkspaceDir(ctx: ProviderWrapStreamFnContext): string | undefined {
	return safeString(ctx.workspaceDir)
}

function resolveAgentDir(ctx: ProviderWrapStreamFnContext): string | undefined {
	const maybeAgentDir = (ctx as unknown as Record<string, unknown>).agentDir
	return safeString(maybeAgentDir)
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
		const headPath = path.join(repoRoot, ".git", "HEAD")
		const head = fs.readFileSync(headPath, "utf8").trim()
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

function runtimeContextHints(ctx: ProviderWrapStreamFnContext): RuntimeContextHints {
	const workspaceDir = resolveWorkspaceDir(ctx)
	const agentDir = resolveAgentDir(ctx)
	const repoRoot = findRepoRoot(workspaceDir)
	const ctxRecord = ctx as unknown as Record<string, unknown>
	const modelRecord = asRecord(ctxRecord.model)
	const modelId = safeString(ctxRecord.modelId) ?? safeString(modelRecord?.id)
	return {
		workspaceDir,
		agentDir,
		repoRoot,
		modelId,
		provider: safeString(ctxRecord.provider),
	}
}

/**
 * Builds a small, sanitized requester runtime envelope for downstream routing.
 *
 * This intentionally includes only bounded, locally-derived hints. It never
 * serializes process.env, git remotes, full git status/diffs, tokens, or
 * arbitrary provider extraParams.
 */
function buildRequesterRuntime(
	ctx: ProviderWrapStreamFnContext,
	sessionId: string,
	source: string
): RequesterRuntime {
	const hints = runtimeContextHints(ctx)
	return {
		schema_version: REQUESTER_RUNTIME_SCHEMA_VERSION,
		source: REQUESTER_RUNTIME_SOURCE,
		capture_mode: "advisory_only",
		session_key: sessionId,
		openclaw_session_id: sessionId,
		...(hints.workspaceDir && { workspace_dir: path.resolve(hints.workspaceDir) }),
		...(hints.agentDir && { agent_dir: path.resolve(hints.agentDir) }),
		...(hints.repoRoot && { repo_root_hint: hints.repoRoot, repo_name: path.basename(hints.repoRoot) }),
		...(hints.repoRoot && { git_branch_hint: readGitHeadBranch(hints.repoRoot) }),
		...(hints.repoRoot && { git_dirty_hint: readGitDirtyHint(hints.repoRoot) }),
		requester_host_id: stableHash(os.hostname(), "host"),
		...(hints.provider && { provider: hints.provider }),
		...(hints.modelId && { model_id: hints.modelId }),
		session_source_hint: stableHash(source, "source"),
		available_bridges: [],
		required_execution_mode: "advisory_only",
		redaction_policy: "no_secrets;bounded_paths;no_env_values;no_git_remotes;no_status_or_diffs;no_extra_params",
	}
}

function isTaasProvider(ctx: ProviderWrapStreamFnContext): boolean {
	const provider = safeString((ctx as unknown as Record<string, unknown>).provider)
	return provider === "cloudsigma" || provider === "cloudsigma-staging"
}

function providerBaseUrl(payload: Record<string, unknown>, ctx: ProviderWrapStreamFnContext): string | undefined {
	const direct = safeString(payload.base_url) ?? safeString(payload.baseURL)
	if (direct) return direct
	const modelRecord = asRecord((ctx as unknown as Record<string, unknown>).model)
	return safeString(modelRecord?.baseUrl) ?? safeString(modelRecord?.baseURL)
}

function requesterBridgeLeaseUrl(payload: Record<string, unknown>, ctx: ProviderWrapStreamFnContext): string | undefined {
	const explicit = safeString(process.env.TAAS_REQUESTER_BRIDGE_LEASE_URL)
	if (explicit) return explicit
	const base = providerBaseUrl(payload, ctx) ?? DEFAULT_TAAS_BASE_URL
	try {
		return new URL(REQUESTER_BRIDGE_LEASE_PATH, base.endsWith("/") ? base : `${base}/`).toString()
	} catch {
		return undefined
	}
}

function bridgeSiblingUrl(leaseUrl: string, pathName: string): string | undefined {
	try {
		const url = new URL(leaseUrl)
		url.pathname = pathName
		url.search = ""
		return url.toString()
	} catch {
		return undefined
	}
}

function pollIntervalMs(): number {
	const value = Number.parseInt(process.env.TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS ?? "", 10)
	if (Number.isFinite(value) && value >= 50) return Math.min(value, 30_000)
	return DEFAULT_POLL_INTERVAL_MS
}

function boundedJson(value: unknown): unknown {
	const encoded = JSON.stringify(value ?? null)
	if (encoded.length <= MAX_ECHO_BYTES) return value
	return { truncated: true, message: "echo payload exceeded bridge scaffold size limit" }
}

async function executeSafeBridgeOperation(operation: BridgePollOperation): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }> {
	if (operation.operation !== REQUESTER_BRIDGE_CAPABILITY && operation.operation !== REQUESTER_BRIDGE_CAPABILITY_LEGACY) {
		return { ok: false, error: { code: "unsupported_operation", message: "Unsupported requester bridge operation" } }
	}
	const args = asRecord(operation.arguments) ?? {}
	const tool = safeString(args.tool) ?? safeString(args.name)
	const toolArgs = asRecord(args.arguments) ?? asRecord(args.input) ?? {}
	if (tool === "bridge.ping") {
		return { ok: true, result: { pong: true, echo: boundedJson(toolArgs), scaffold: true } }
	}
	if (tool === "bridge.echo") {
		return { ok: true, result: { echo: boundedJson(toolArgs), scaffold: true } }
	}
	return { ok: false, error: { code: "tool_not_available", message: "Requester bridge scaffold only supports bridge.ping and bridge.echo" } }
}

async function postBridgeResult(resultsUrl: string, descriptor: Record<string, unknown>, operation: BridgePollOperation, outcome: Awaited<ReturnType<typeof executeSafeBridgeOperation>>): Promise<void> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), POLL_REQUEST_TIMEOUT_MS)
	try {
		await fetch(resultsUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				schema_version: REQUESTER_RUNTIME_SCHEMA_VERSION,
				lease_id: descriptor.lease_id,
				bridge_id: descriptor.bridge_id,
				auth_context_id: descriptor.auth_context_id,
				operation_id: operation.operation_id,
				audit_id: operation.audit_id,
				...outcome,
			}),
			signal: controller.signal,
		})
	} catch (err) {
		if (isDev) console.debug(`[taas-affinity] requester bridge result post failed: ${err instanceof Error ? err.name : "unknown"}`)
	} finally {
		clearTimeout(timer)
	}
}

async function pollRequesterBridgeOnce(pollUrl: string, resultsUrl: string, descriptor: Record<string, unknown>, state: PollerState): Promise<void> {
	if (state.inFlight) return
	state.inFlight = true
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), POLL_REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(pollUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				schema_version: REQUESTER_RUNTIME_SCHEMA_VERSION,
				lease_id: descriptor.lease_id,
				bridge_id: descriptor.bridge_id,
				auth_context_id: descriptor.auth_context_id,
				max_operations: 10,
			}),
			signal: controller.signal,
		})
		if (!response.ok) return
		const json = await response.json() as { operations?: unknown }
		const operations = Array.isArray(json.operations) ? json.operations : []
		for (const raw of operations) {
			const operation = asRecord(raw) as BridgePollOperation | undefined
			if (!operation || !operation.operation_id) continue
			const outcome = await executeSafeBridgeOperation(operation)
			await postBridgeResult(resultsUrl, descriptor, operation, outcome)
		}
	} catch (err) {
		if (isDev) console.debug(`[taas-affinity] requester bridge poll failed: ${err instanceof Error ? err.name : "unknown"}`)
	} finally {
		clearTimeout(timer)
		state.inFlight = false
	}
}

function startRequesterBridgePoller(leaseUrl: string, descriptor: Record<string, unknown>): void {
	const leaseId = safeString(descriptor.lease_id)
	if (!leaseId || activePollers.has(leaseId)) return
	const pollUrl = bridgeSiblingUrl(leaseUrl, REQUESTER_BRIDGE_POLL_PATH)
	const resultsUrl = bridgeSiblingUrl(leaseUrl, REQUESTER_BRIDGE_RESULTS_PATH)
	if (!pollUrl || !resultsUrl) return
	const state: PollerState = { inFlight: false }
	activePollers.set(leaseId, state)
	const tick = () => { void pollRequesterBridgeOnce(pollUrl, resultsUrl, descriptor, state) }
	state.timer = setInterval(tick, pollIntervalMs())
	state.timer.unref?.()
	tick()
}

function isSafeDescriptor(value: unknown): value is Record<string, unknown> {
	const descriptor = asRecord(value)
	if (!descriptor) return false
	if ("bridge_required" in descriptor) return false
	const capabilities = descriptor.capabilities
	if (!Array.isArray(capabilities) || (capabilities.includes(REQUESTER_BRIDGE_CAPABILITY) === false && capabilities.includes(REQUESTER_BRIDGE_CAPABILITY_LEGACY) === false)) {
		return false
	}
	const encoded = JSON.stringify(descriptor)
	const lowered = encoded.toLowerCase()
	return ![
		"endpoint_url",
		"access_token",
		"refresh_token",
		"authorization",
		"bearer ",
		"api_key",
		"apikey",
		"password",
		"secret",
	].some((needle) => lowered.includes(needle))
}

async function createRequesterBridgeLease(
	url: string,
	runtime: RequesterRuntime,
	ctx: ProviderWrapStreamFnContext
): Promise<Record<string, unknown> | undefined> {
	const workspaceDir = safeString(runtime.workspace_dir)
	const repoRoot = safeString(runtime.repo_root_hint)
	const repoName = safeString(runtime.repo_name)
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), LEASE_REQUEST_TIMEOUT_MS)
	try {
		const body = {
			schema_version: REQUESTER_RUNTIME_SCHEMA_VERSION,
			session_key: runtime.session_key,
			openclaw_session_id: runtime.openclaw_session_id,
			requester_host_id: runtime.requester_host_id,
			workspace: {
				...(workspaceDir && { workspace_dir: workspaceDir }),
				...(repoRoot && { repo_root: repoRoot }),
				...(repoName && { repo_name: repoName }),
			},
			capabilities: [REQUESTER_BRIDGE_CAPABILITY],
			ttl_s: REQUESTER_BRIDGE_DEFAULT_TTL_SECONDS,
			callback: { mode: "poll" },
			client: {
				source: REQUESTER_RUNTIME_SOURCE,
				provider: runtime.provider,
				model_id: runtime.model_id,
			},
		}
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Session-Id": String(runtime.session_key),
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		})
		if (!response.ok) {
			if (isDev) console.debug(`[taas-affinity] requester bridge lease failed status=${response.status}`)
			return undefined
		}
		const json = (await response.json()) as LeaseResponse
		if (!json.ok || !isSafeDescriptor(json.descriptor)) return undefined
		const descriptor = json.descriptor
		startRequesterBridgePoller(url, descriptor)
		return descriptor
	} catch (err) {
		if (isDev) console.debug(`[taas-affinity] requester bridge lease unavailable: ${err instanceof Error ? err.name : "unknown"}`)
		return undefined
	} finally {
		clearTimeout(timer)
	}
}

async function maybeUpgradeRequesterRuntimeWithBridge(
	runtime: RequesterRuntime,
	payload: Record<string, unknown>,
	ctx: ProviderWrapStreamFnContext
): Promise<RequesterRuntime> {
	if (!requesterBridgePluginEnabled() || !isTaasProvider(ctx)) return runtime
	const url = requesterBridgeLeaseUrl(payload, ctx)
	if (!url) {
		if (isDev) console.debug("[taas-affinity] requester bridge enabled but no TaaS base URL found")
		return runtime
	}
	const descriptor = await createRequesterBridgeLease(url, runtime, ctx)
	if (!descriptor) return runtime
	return {
		...runtime,
		capture_mode: "bridge_capable",
		available_bridges: [descriptor],
		required_execution_mode: "advisory_only",
	}
}

async function patchPayloadMetadata(
	payload: Record<string, unknown>,
	sessionId: string,
	requesterRuntime?: RequesterRuntime,
	ctx?: ProviderWrapStreamFnContext
): Promise<Record<string, unknown>> {
	const existingMeta = asRecord(payload.metadata) ?? {}
	// Never overwrite existing metadata fields — the caller owns them.
	const needsSessionId = !existingMeta.session_id
	const needsStickyKey = !existingMeta.sticky_key
	const needsRequesterRuntime = requesterRuntime && !existingMeta.requester_runtime
	if (!needsSessionId && !needsStickyKey && !needsRequesterRuntime) return payload
	const runtime = needsRequesterRuntime && requesterRuntime && ctx
		? await maybeUpgradeRequesterRuntimeWithBridge(requesterRuntime, payload, ctx)
		: requesterRuntime
	return {
		...payload,
		metadata: {
			...existingMeta,
			...(needsSessionId && { session_id: sessionId }),
			...(needsStickyKey && { sticky_key: sessionId }),
			...(needsRequesterRuntime && { requester_runtime: runtime }),
		},
	}
}

function buildWrapper(ctx: ProviderWrapStreamFnContext) {
	const { streamFn } = ctx
	if (!streamFn) return undefined

	const { sessionId, source } = resolveSessionId(ctx.workspaceDir)
	const requesterRuntime = buildRequesterRuntime(ctx, sessionId, source)

	if (isDev) {
		console.debug(`[taas-affinity] wrapStreamFn sessionId=${sessionId} source=${source}`)
	}

	const inner = streamFn
	return function taasAffinityStreamFn(...args: Parameters<typeof inner>) {
		const [model, context, options] = args
		const prevOnPayload = options?.onPayload
		const onPayload: NonNullable<typeof options>["onPayload"] = async (
			payload,
			payloadModel
		) => {
			const payloadRecord = asRecord(payload)
			if (!payloadRecord) {
				if (prevOnPayload) return prevOnPayload(payload, payloadModel)
				return payload
			}
			const patched = await patchPayloadMetadata(payloadRecord, sessionId, requesterRuntime, ctx)
			if (prevOnPayload) return prevOnPayload(patched, payloadModel)
			return patched
		}
		return inner(model, context, { ...options, onPayload })
	} as typeof inner
}

/**
 * Injects X-Session-Id as a per-turn transport header.
 *
 * resolveTransportTurnState is called by generic HTTP and WebSocket transports
 * to attach provider-native headers on every request turn. This is the correct
 * SDK hook for header injection — onPayload only controls the body.
 *
 * Note: ctx.sessionId here is OpenClaw's own internal ephemeral session UUID,
 * not the TaaS affinity ID we derive. We derive our own ID from workspaceDir /
 * env vars so the TaaS affinity signal is stable across retries within a turn.
 */
function buildTransportTurnState(
	ctx: ProviderResolveTransportTurnStateContext
): ProviderTransportTurnState | null {
	// We don't have ctx.workspaceDir here (it's not on this context type),
	// so use the active session source tiers directly.
	const activeSource = getActiveSessionSource()
	const sessionId = activeSource
		? deriveSessionId(activeSource)
		: fallbackSessionId()

	if (isDev) {
		console.debug(
			`[taas-affinity] resolveTransportTurnState sessionId=${sessionId} ` +
				`source=${activeSource ?? "stateDir-fallback"} ` +
				`turnId=${ctx.turnId} attempt=${ctx.attempt}`
		)
	}

	return {
		headers: {
			"X-Session-Id": sessionId,
		},
	}
}

export default {
	id: "openclaw-taas-affinity",
	name: "CloudSigma TaaS Token Cache Optimizer",
	description:
		"Injects a stable per-conversation session ID into outbound LLM requests so TaaS can " +
		"pin sessions to the same upstream slot from turn 1, maximising prompt-cache hit rates.",

	register(api: OpenClawPluginApi) {
		// Unique id avoids conflicting with the config-driven "cloudsigma" provider.
		// hookAliases routes cloudsigma/cloudsigma-staging requests to this hook.
		api.registerProvider({
			id: "taas-affinity-hook",
			label: "CloudSigma TaaS Token Cache Optimizer",
			hookAliases: ["cloudsigma", "cloudsigma-staging"],
			auth: [],
			wrapStreamFn: buildWrapper,
			resolveTransportTurnState: buildTransportTurnState,
		})
	},
}

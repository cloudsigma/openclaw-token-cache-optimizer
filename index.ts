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
const PLUGIN_VERSION = "0.5.3"

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

function deriveSessionId(source: string): string {
	const normalised = source.startsWith("env:") || source.startsWith("agent:") || source.startsWith("session:")
		? source
		: path.resolve(source)
	const hex = createHash("sha256").update(normalised, "utf8").digest("hex")
	return `${SESSION_ID_PREFIX}${hex.slice(0, 16)}`
}

function resolveLocalConversationSource(ctx: { sessionId?: unknown }): string | undefined {
	const sessionId = safeString(ctx.sessionId)
	return sessionId ? `session:${sessionId}` : undefined
}

function getActiveSessionSource(): string | undefined {
	const envSessionId = process.env.OPENCLAW_SESSION_ID
	if (envSessionId) return `env:${envSessionId}`

	const envAgentId = process.env.OPENCLAW_AGENT_ID ?? process.env.OPENCLAW_RUN_ID
	if (envAgentId) return `agent:${envAgentId}`

	const state = (globalThis as Record<symbol, unknown>)[PLUGIN_REGISTRY_STATE] as
		| { workspaceDir?: string }
		| null
		| undefined
	return state?.workspaceDir
}

function fallbackSessionSource(): string {
	const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw")
	return `stateDir:${stateDir}`
}

function resolveSessionId(workspaceDirFromCtx?: string, sessionIdFromCtx?: unknown): { sessionId: string; source: string; sourceHint: string; localSessionScoped: boolean } {
	const conversationSource = resolveLocalConversationSource({ sessionId: sessionIdFromCtx })
	if (conversationSource) {
		const diagnosticSource = workspaceDirFromCtx ? `workspaceDir:${workspaceDirFromCtx}` : (getActiveSessionSource() ?? fallbackSessionSource())
		return {
			sessionId: deriveSessionId(conversationSource),
			source: conversationSource,
			sourceHint: diagnosticSource,
			localSessionScoped: true,
		}
	}

	if (workspaceDirFromCtx) {
		return {
			sessionId: deriveSessionId(workspaceDirFromCtx),
			source: `workspaceDir:${workspaceDirFromCtx}`,
			sourceHint: `workspaceDir:${workspaceDirFromCtx}`,
			localSessionScoped: false,
		}
	}

	const activeSource = getActiveSessionSource() ?? fallbackSessionSource()
	return {
		sessionId: deriveSessionId(activeSource),
		source: activeSource,
		sourceHint: activeSource,
		localSessionScoped: false,
	}
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
		session_identity_scope: source.startsWith("session:") ? "local_session" : "legacy_source",
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
		session_identity_scope: source.startsWith("session:") ? "local_session" : "legacy_source",
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

	const { sessionId, source, sourceHint, localSessionScoped } = resolveSessionId(ctx.workspaceDir, (ctx as { sessionId?: unknown }).sessionId)
	const agentIdForCapture = deriveAgentIdForCapture(ctx as { agentDir?: string; workspaceDir?: string })
	const requesterRuntime = localSessionScoped ? buildRequesterRuntime(ctx, sessionId, source, sourceHint) : undefined
	const correlation = localSessionScoped ? buildCorrelationMetadata(sessionId, source, sourceHint, ctx, agentIdForCapture) : undefined

	if (isDev) console.debug(`[taas-affinity] wrapStreamFn sessionId=${sessionId} source=${source}`)

	const inner = streamFn
	return function taasAffinityStreamFn(...args: Parameters<typeof inner>) {
		const [model, context, options] = args
		const prevOnPayload = options?.onPayload
		const onPayload: NonNullable<typeof options>["onPayload"] = async (payload, payloadModel) => {
			const payloadRecord = asRecord(payload)
			if (!payloadRecord) return prevOnPayload ? prevOnPayload(payload, payloadModel) : payload
			const patched = patchPayloadMetadata(payloadRecord, sessionId, requesterRuntime, correlation, localSessionScoped)
			return prevOnPayload ? prevOnPayload(patched, payloadModel) : patched
		}
		const prevOnResponse = options?.onResponse
		const onResponse: NonNullable<typeof options>["onResponse"] = async (response, responseModel) => {
			try {
				captureAutorouterFromHeaders(sessionId, response?.headers ?? {}, agentIdForCapture)
			} catch (err) {
				if (isDev) console.debug(`[taas-affinity] onResponse capture failed: ${(err as Error)?.message ?? err}`)
			}
			if (prevOnResponse) await prevOnResponse(response, responseModel)
		}
		return inner(model, context, { ...options, onPayload, onResponse })
	} as typeof inner
}

function buildTransportTurnState(ctx: ProviderResolveTransportTurnStateContext): ProviderTransportTurnState | null {
	const activeSource = resolveLocalConversationSource(ctx as { sessionId?: unknown }) ?? getActiveSessionSource() ?? fallbackSessionSource()
	const sessionId = deriveSessionId(activeSource)
	const agentId = deriveAgentIdForCapture(ctx as unknown as { agentDir?: string; workspaceDir?: string })
	if (isDev) {
		console.debug(
			`[taas-affinity] resolveTransportTurnState sessionId=${sessionId} ` +
				`source=${activeSource} turnId=${ctx.turnId} attempt=${ctx.attempt}`
		)
	}
	return { headers: buildCorrelationHeaders({ sessionId, turnId: ctx.turnId, attempt: ctx.attempt, agentId }) }
}

export default {
	id: "openclaw-taas-affinity",
	name: "CloudSigma TaaS Token Cache Optimizer",
	description:
		"Injects a stable per-conversation session ID into outbound LLM requests so TaaS can " +
		"pin sessions to the same upstream slot from turn 1, maximising prompt-cache hit rates.",

	register(api: OpenClawPluginApi) {
		api.registerProvider({
			id: "taas-affinity-hook",
			label: "CloudSigma TaaS Token Cache Optimizer",
			hookAliases: ["cloudsigma", "cloudsigma-staging"],
			auth: [],
			wrapStreamFn: buildWrapper,
			resolveTransportTurnState: buildTransportTurnState,
		})

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

				const resolvedSessionId = directSessionId ?? resolveSessionId(workspaceDir, safeString(pp.localSessionId)).sessionId
				respond(true, {
					sessionId: resolvedSessionId,
					capture: getLastRouteForSession(resolvedSessionId),
				})
			},
			{ scope: "operator.read" }
		)
	},

	_testExports: {
		buildRequesterRuntime,
		patchPayloadMetadata,
		resolveSessionId,
		captureAutorouterFromHeaders,
		buildCorrelationHeaders,
		buildCorrelationMetadata,
		getLastRouteForAgent,
		getLastRouteForSession,
	},
}

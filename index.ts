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
 * ## How it works
 *
 * 1. Derives a stable session ID from the active agent's workspace directory path
 *    (or env-var fallbacks for sub-agent contexts — see Tier list below).
 *    Different agents (different workspaces) get different IDs.
 *
 * 2. Injects two fields into every outbound request body (never overwrites an
 *    existing value so callers can still override):
 *      body.metadata.session_id  — read by TaaS OpenAI-compat affinity path
 *      body.metadata.sticky_key  — read by TaaS Anthropic affinity path
 *
 * 3. Also injects an X-Session-Id request header via resolveTransportTurnState
 *    for transport layers that honour native per-turn headers.
 *
 * ## Session ID derivation tiers
 *
 * Tier 1 (best): ctx.workspaceDir passed explicitly by OpenClaw
 * Tier 2:        globalThis[PLUGIN_REGISTRY_STATE].workspaceDir — parent agent workspace
 * Tier 3:        process.env.OPENCLAW_SESSION_ID — if OpenClaw sets this for sub-agents
 * Tier 4:        process.env.OPENCLAW_AGENT_ID ?? process.env.OPENCLAW_RUN_ID
 * Tier 5 (last): OPENCLAW_STATE_DIR hash — per-installation, least specific
 *
 * ## Manifest wiring
 *
 * The plugin registers with id "taas-affinity-hook" (unique, avoids conflicting
 * with the config-driven "cloudsigma" provider) and uses hookAliases to tell
 * matchesProviderId that this plugin handles cloudsigma and cloudsigma-staging
 * requests. The manifest providers array tells resolveOwningPluginIdsForProvider
 * to load this plugin when those providers are active.
 */

const SESSION_ID_PREFIX = "oc:"
const REQUESTER_RUNTIME_SCHEMA_VERSION = "2026-05-18"
const REQUESTER_RUNTIME_SOURCE = "openclaw-token-cache-optimizer"
const GIT_PROBE_TIMEOUT_MS = 250

// OpenClaw stores the active registry state (including workspaceDir) on globalThis
// under this well-known symbol key.
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState")

const isDev =
	process.env.NODE_ENV === "development" || Boolean(process.env.OPENCLAW_DEBUG)

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
): Record<string, unknown> {
	const workspaceDir = resolveWorkspaceDir(ctx)
	const agentDir = resolveAgentDir(ctx)
	const repoRoot = findRepoRoot(workspaceDir)
	const ctxRecord = ctx as unknown as Record<string, unknown>
	const modelRecord = asRecord(ctxRecord.model)
	const modelId = safeString(ctxRecord.modelId) ?? safeString(modelRecord?.id)

	return {
		schema_version: REQUESTER_RUNTIME_SCHEMA_VERSION,
		source: REQUESTER_RUNTIME_SOURCE,
		capture_mode: "advisory_only",
		session_key: sessionId,
		openclaw_session_id: sessionId,
		...(workspaceDir && { workspace_dir: path.resolve(workspaceDir) }),
		...(agentDir && { agent_dir: path.resolve(agentDir) }),
		...(repoRoot && { repo_root_hint: repoRoot, repo_name: path.basename(repoRoot) }),
		...(repoRoot && { git_branch_hint: readGitHeadBranch(repoRoot) }),
		...(repoRoot && { git_dirty_hint: readGitDirtyHint(repoRoot) }),
		requester_host_id: stableHash(os.hostname(), "host"),
		...(safeString(ctxRecord.provider) && { provider: safeString(ctxRecord.provider) }),
		...(modelId && { model_id: modelId }),
		session_source_hint: stableHash(source, "source"),
		available_bridges: [],
		required_execution_mode: "advisory_only",
		redaction_policy: "no_secrets;bounded_paths;no_env_values;no_git_remotes;no_status_or_diffs;no_extra_params",
	}
}

function patchPayloadMetadata(
	payload: Record<string, unknown>,
	sessionId: string,
	requesterRuntime?: Record<string, unknown>
): Record<string, unknown> {
	const existingMeta = asRecord(payload.metadata) ?? {}
	// Never overwrite existing metadata fields — the caller owns them.
	const needsSessionId = !existingMeta.session_id
	const needsStickyKey = !existingMeta.sticky_key
	const needsRequesterRuntime = requesterRuntime && !existingMeta.requester_runtime
	if (!needsSessionId && !needsStickyKey && !needsRequesterRuntime) return payload
	return {
		...payload,
		metadata: {
			...existingMeta,
			...(needsSessionId && { session_id: sessionId }),
			...(needsStickyKey && { sticky_key: sessionId }),
			...(needsRequesterRuntime && { requester_runtime: requesterRuntime }),
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
			const patched = patchPayloadMetadata(payloadRecord, sessionId, requesterRuntime)
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

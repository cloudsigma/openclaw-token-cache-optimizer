import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import type { OpenClawPluginApi, ProviderWrapStreamFnContext } from "openclaw/plugin-sdk"

/**
 * openclaw-taas-affinity
 *
 * Injects a stable per-conversation session ID (oc:<sha256-prefix>) into every
 * outbound request to CloudSigma TaaS providers so the session-affinity layer
 * achieves confidence=1.0 from turn 1, maximising prompt-cache hit rates.
 *
 * ## How it works
 *
 * 1. Derives a stable session ID from the active agent's workspace directory path.
 *    Different agents (different workspaces) get different IDs; subagents get their
 *    own workspace-scoped ID.
 *
 * 2. Injects two fields into every outbound request body (never overwrites an
 *    existing value so callers can still override):
 *      body.metadata.session_id  — read by TaaS OpenAI-compat affinity path
 *      body.metadata.sticky_key  — read by TaaS Anthropic affinity path
 *
 * ## Manifest wiring
 *
 * The plugin registers with id "taas-affinity-hook" (unique, avoids conflicting
 * with the config-driven "cloudsigma" provider) and uses hookAliases to tell
 * matchesProviderId that this plugin handles cloudsigma and cloudsigma-staging
 * requests. The manifest providers array tells resolveOwningPluginIdsForProvider
 * to load this plugin when those providers are active.
 *
 * ## workspaceDir
 *
 * The OpenClaw call site for wrapStreamFn does not currently populate
 * ctx.workspaceDir, so we read it from the global plugin registry state
 * (Symbol.for("openclaw.pluginRegistryState")) — the same source used
 * internally by resolveProviderPluginsForHooks.
 */

const SESSION_ID_PREFIX = "oc:"

// OpenClaw stores the active registry state (including workspaceDir) on globalThis
// under this well-known symbol key.
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState")

function getActiveWorkspaceDir(): string | undefined {
	const state = (globalThis as Record<symbol, unknown>)[PLUGIN_REGISTRY_STATE] as
		| { workspaceDir?: string }
		| null
		| undefined
	return state?.workspaceDir
}

function deriveSessionId(workspaceDir: string): string {
	const normalised = path.resolve(workspaceDir)
	const hex = createHash("sha256").update(normalised, "utf8").digest("hex")
	return `${SESSION_ID_PREFIX}${hex.slice(0, 16)}`
}

function fallbackSessionId(): string {
	// Fallback when no workspace is available (e.g. setup runtime).
	// Uses the OpenClaw state dir — stable per installation but not per agent.
	const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw")
	return deriveSessionId(stateDir)
}

function patchPayloadMetadata(
	payload: Record<string, unknown>,
	sessionId: string
): Record<string, unknown> {
	const existingMeta =
		payload.metadata !== null &&
		typeof payload.metadata === "object" &&
		!Array.isArray(payload.metadata)
			? (payload.metadata as Record<string, unknown>)
			: {}
	// Never overwrite an existing session_id/sticky_key — the caller owns it.
	const needsSessionId = !existingMeta.session_id
	const needsStickyKey = !existingMeta.sticky_key
	if (!needsSessionId && !needsStickyKey) return payload
	return {
		...payload,
		metadata: {
			...existingMeta,
			...(needsSessionId && { session_id: sessionId }),
			...(needsStickyKey && { sticky_key: sessionId }),
		},
	}
}

function buildWrapper(ctx: ProviderWrapStreamFnContext) {
	const { streamFn } = ctx
	if (!streamFn) return undefined

	const workspaceDir = ctx.workspaceDir ?? getActiveWorkspaceDir()
	const sessionId = workspaceDir ? deriveSessionId(workspaceDir) : fallbackSessionId()

	const inner = streamFn
	return function taasAffinityStreamFn(model, context, options) {
		const prevOnPayload = options?.onPayload
		const onPayload = async (
			payload: Record<string, unknown>,
			payloadModel: typeof model
		) => {
			const patched = patchPayloadMetadata(payload, sessionId)
			if (prevOnPayload) return prevOnPayload(patched, payloadModel)
			return patched
		}
		return inner(model, context, { ...options, onPayload })
	} as typeof inner
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
			hookAliases: ["cloudsigma", "cloudsigma-staging"],
			auth: [],
			wrapStreamFn: buildWrapper,
		})
	},
}

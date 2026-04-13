/**
 * openclaw-taas-affinity
 *
 * OpenClaw provider plugin for CloudSigma TaaS session affinity.
 *
 * ## What it does
 *
 * CloudSigma TaaS routes each request to one of its upstream model slots
 * (OAuth tokens, Bedrock regions, Claude Code nodes). Its session-affinity
 * layer tries to keep multi-turn conversations on the same slot so prompt
 * caches are hot.
 *
 * Without this plugin, TaaS falls back to heuristic matching (tool-use-id
 * chains, structural inference) which only works well mid-conversation and
 * can't bind on the very first turn.
 *
 * This plugin injects two fields into every outbound request body:
 *
 *   body.metadata.session_id  — stable per OpenClaw session/workspace
 *   body.metadata.sticky_key  — same value; Anthropic substrate reads this
 *
 * TaaS reads `X-Session-Id` header OR `body.metadata.{session_id,sticky_key}`
 * and short-circuits all heuristics to confidence=1.0 from turn 1.
 *
 * ## Session ID derivation
 *
 * OpenClaw's plugin `wrapStreamFn` hook receives the session's `workspaceDir`
 * — a path that is stable across all turns of the same conversation and unique
 * per session (main, subagent, cron, etc).  We hash it with SHA-256 and take
 * the first 16 hex chars, then prefix with `oc:` to namespace it away from
 * other TaaS clients:
 *
 *   oc:a3f2c1b0e9d87654          ← main session
 *   oc:7f1d4c3a2e9b0856          ← subagent (different workspaceDir)
 *   oc:2a8e5f0c1d3b7946          ← next conversation (new session)
 *
 * ## Scope per session type
 *
 * | Session type          | ID scope                            |
 * |----------------------|-------------------------------------|
 * | Main agent           | Own stable ID (workspaceDir-based) |
 * | Spawned subagent     | Own ID (separate workspaceDir)     |
 * | Cron / isolated run  | Own ID (isolated workspace)        |
 * | New conversation     | New ID (workspace resets)          |
 * | Parallel sessions    | Separate IDs                        |
 *
 * ## TaaS compatibility
 *
 * Requires TaaS commit 61a9960+ ("feat: session affinity short-circuit via
 * X-Session-Id header", April 2026).
 *
 * ## Installation
 *
 * Drop this directory into ~/.openclaw/extensions/openclaw-taas-affinity/
 * and restart OpenClaw, or install from ClaWHub once published.
 *
 * No configuration required. The plugin only activates for the "cloudsigma"
 * provider and is a no-op for all other providers.
 */

import { createHash } from "node:crypto"
import path from "node:path"
import type { OpenClawPluginApi, ProviderWrapStreamFnContext } from "openclaw/plugin-sdk"

// ── Constants ─────────────────────────────────────────────────────────────────

/** The provider ID this plugin hooks into. Only CloudSigma requests are patched. */
const TAAS_PROVIDER_ID = "cloudsigma"

/**
 * Prefix for session IDs to distinguish OpenClaw sessions from other TaaS
 * clients (Claude Code, direct API users, etc.).
 */
const SESSION_ID_PREFIX = "oc:"

// ── Session ID derivation ─────────────────────────────────────────────────────

/**
 * Derive a stable, opaque session identifier from the session's workspace dir.
 *
 * The workspaceDir is:
 * - Stable: same path for every turn in the same OpenClaw session.
 * - Unique: each session (main, subagent, cron) gets a distinct path.
 * - Resets: a new conversation (/new, /reset) gets a new workspace dir.
 *
 * We SHA-256 hash the normalised path and take 16 hex chars (64 bits of
 * collision resistance — more than sufficient for session IDs).
 */
function deriveSessionId(workspaceDir: string): string {
	const normalised = path.resolve(workspaceDir)
	const hex = createHash("sha256").update(normalised, "utf8").digest("hex")
	return `${SESSION_ID_PREFIX}${hex.slice(0, 16)}`
}

// ── Payload patch helper ──────────────────────────────────────────────────────

/**
 * Inject session affinity fields into the outbound request body.
 *
 * TaaS checks (in priority order):
 *  1. X-Session-Id HTTP request header   ← can't inject from plugin hooks
 *  2. body.metadata.session_id           ← injected here ✓
 *  3. body.metadata.sticky_key           ← injected here ✓ (Anthropic lane)
 *
 * We only set each field if it isn't already present, so explicit caller
 * overrides always win.
 */
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

	const needsSessionId = !existingMeta.session_id
	const needsStickyKey = !existingMeta.sticky_key

	if (!needsSessionId && !needsStickyKey) return payload // nothing to do

	return {
		...payload,
		metadata: {
			...existingMeta,
			...(needsSessionId && { session_id: sessionId }),
			...(needsStickyKey && { sticky_key: sessionId }),
		},
	}
}

// ── Plugin export ─────────────────────────────────────────────────────────────

export default {
	id: "openclaw-taas-affinity",
	name: "CloudSigma TaaS Session Affinity",
	description:
		"Injects a stable per-conversation session ID into CloudSigma TaaS " +
		"requests so the affinity layer can pin sessions to the same upstream " +
		"slot from the very first turn, maximising prompt-cache hit rates.",

	register(api: OpenClawPluginApi) {
		api.registerProvider({
			id: TAAS_PROVIDER_ID,
			label: "CloudSigma (TaaS affinity)",

			/**
			 * Wrap the base stream function to inject affinity metadata.
			 *
			 * Called once per session run. The returned StreamFn is used for
			 * every turn in that session.
			 */
			wrapStreamFn(ctx: ProviderWrapStreamFnContext) {
				const { streamFn, workspaceDir, provider } = ctx

				// Guard: only patch requests to the cloudsigma provider.
				if (provider !== TAAS_PROVIDER_ID) return streamFn ?? undefined

				// Guard: need a workspaceDir to derive the session ID.
				// Without it we fall through to TaaS heuristic matching.
				if (!workspaceDir) return streamFn ?? undefined

				const inner = streamFn
				if (!inner) return undefined

				const sessionId = deriveSessionId(workspaceDir)

				// Wrap: intercept onPayload to inject session fields.
				return function taasAffinityStreamFn(model, context, options) {
					const prevOnPayload = options?.onPayload

					const onPayload = async (
						payload: Record<string, unknown>,
						payloadModel: typeof model
					) => {
						const patched = patchPayloadMetadata(payload, sessionId)
						// Chain any previously registered onPayload handler.
						if (prevOnPayload) return prevOnPayload(patched, payloadModel)
						return patched
					}

					return inner(model, context, { ...options, onPayload })
				} as typeof inner
			},
		})
	},
}

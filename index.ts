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
 * Requester-side tool execution is handled by OpenClaw / Claude Code / TaaS
 * Direction-2. This plugin only provides affinity metadata, the X-Session-Id
 * transport header, and TaaS autorouter response-header capture.
 */

const SESSION_ID_PREFIX = "oc:"
const REQUESTER_RUNTIME_SCHEMA_VERSION = "2026-06-03"
const REQUESTER_RUNTIME_SOURCE = "openclaw-token-cache-optimizer"
const GIT_PROBE_TIMEOUT_MS = 250

type RequesterRuntime = Record<string, unknown>

type RuntimeContextHints = {
	workspaceDir?: string
	agentDir?: string
	repoRoot?: string
	modelId?: string
	provider?: string
}

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
		session_key: sessionId,
		openclaw_session_id: sessionId,
		requester_host_id: stableHash(os.hostname(), "host"),
		...(hints.repoRoot && { repo_name: path.basename(hints.repoRoot) }),
		...(hints.repoRoot && { git_branch_hint: readGitHeadBranch(hints.repoRoot) }),
		...(hints.repoRoot && { git_dirty_hint: readGitDirtyHint(hints.repoRoot) }),
		...(hints.provider && { provider: hints.provider }),
		...(hints.modelId && { model_id: hints.modelId }),
		session_source_hint: stableHash(source, "source"),
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
	requesterRuntime?: RequesterRuntime
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

/**
 * Captured autorouter metadata per-session, populated by the onResponse callback
 * installed in `buildWrapper`. Exposed via the `taas.autorouter.lastRoute` gateway
 * RPC so Alien AI Studio (or any other client) can pull the latest TaaS routing
 * decision for a session — including the actual model chosen by the autorouter,
 * the algorithm used, the source of that algorithm (org/dept/key/user/system),
 * the thinking level applied, and the chosen model's context window.
 *
 * The map is keyed by the affinity session ID we already derive in
 * `resolveSessionId(ctx.workspaceDir)`. Stored values are bounded — see
 * `LAST_ROUTE_LIMIT` — to avoid unbounded growth in long-lived gateways.
 */
type AutorouterCapture = {
	sessionId: string
	capturedAt: number
	autorouterModel: string | null
	autorouterAlgo: string | null
	autorouterAlgoSource: string | null
	thinkingApplied: string | null
	routedContextWindow: number | null
}


// ── Trash sweeper configuration ──────────────────────────────────────────────
const SWEEP_INTERVAL_MS = Number(process.env.TAAS_AFFINITY_SWEEP_INTERVAL_MS) || 3_600_000
const SWEEP_STALE_DAYS = Number(process.env.TAAS_AFFINITY_SWEEP_STALE_DAYS) || 7
const SWEEP_TRAJECTORY_MAX_MB = Number(process.env.TAAS_AFFINITY_SWEEP_TRAJECTORY_MAX_MB) || 50
const SWEEP_TRAJECTORY_KEEP_MB = Number(process.env.TAAS_AFFINITY_SWEEP_TRAJECTORY_KEEP_MB) || 10
const SWEEP_LOCK_ORPHAN_MIN = Number(process.env.TAAS_AFFINITY_SWEEP_LOCK_ORPHAN_MIN) || 60
const SWEEP_CHECKPOINT_KEEP = Number(process.env.TAAS_AFFINITY_SWEEP_CHECKPOINT_KEEP) || 3

// ── Stuck-run status writer configuration ────────────────────────────────────
const STATUS_INTERVAL_MS = 30_000
const STATUS_WARN_MS = 5 * 60_000
const STATUS_STUCK_MS = 15 * 60_000
const STATUS_ZOMBIE_MS = 60 * 60_000
const STATUS_PATH = process.env.TAAS_AFFINITY_RUNS_STATUS_PATH
	|| path.join(os.homedir(), ".openclaw", "alien-studio", "runs-status.json")

// ── Zombie auto-abort configuration ───────────────────────────────────────────
// ⚠️  PLUGIN BLOCKED: No plugin-side dispatch for chat.abort exists in the OpenClaw
//     plugin SDK. The default abortRun function logs a warning and is a no-op.
//     When the SDK adds api.runtime.chat.abort() or dispatchGatewayMethod(),
//     replace the default abortRun in register() below.
//     Set TAAS_AFFINITY_AUTO_ABORT_ZOMBIES=true to enable (currently opt-in).
const AUTO_ABORT_ENABLED = process.env.TAAS_AFFINITY_AUTO_ABORT_ZOMBIES === "true"
const AUTO_ABORT_DRY_RUN = process.env.TAAS_AFFINITY_AUTO_ABORT_DRY_RUN === "true"
const AUTO_ABORT_THRESHOLD_MS = Number(process.env.TAAS_AFFINITY_AUTO_ABORT_THRESHOLD_MS) || STATUS_ZOMBIE_MS
const AUTO_ABORT_CHECK_INTERVAL_MS = Number(process.env.TAAS_AFFINITY_AUTO_ABORT_CHECK_INTERVAL_MS) || 60_000
const AUTO_ABORT_ABORTED_SET_MAX = 1000

/** In-memory set of sessionKeys already aborted in this process (LRU-bounded). */
const abortedInThisProcess: string[] = []

/**
 * Injected abort function. Default logs a warning because the plugin SDK does not
 * expose a way to dispatch chat.abort from inside a plugin. Replace via
 * setAbortRunFn() in tests or when the SDK adds the capability.
 */
let abortRun: (sessionKey: string) => Promise<void> = async (sessionKey: string) => {
	console.warn("[taas-affinity] auto-abort: chat.abort not available via plugin SDK; sessionKey=" + sessionKey)
}

/** Replace the abort function (for testing or future SDK integration). */
function setAbortRunFn(fn: (sessionKey: string) => Promise<void>): void {
	abortRun = fn
}

// ── Trash sweeper ────────────────────────────────────────────────────────────
let sweepInProgress = false

function runTrashSweep(agentsDir?: string): void {
	if (sweepInProgress) return
	sweepInProgress = true
	const t0 = Date.now()
	let deleted = 0
	let truncated = 0
	let orphanedLocks = 0
	try {
		const base = agentsDir || path.join(os.homedir(), ".openclaw", "agents")
		let agents: string[]
		try { agents = fs.readdirSync(base) } catch { sweepInProgress = false; return }
		const staleMs = SWEEP_STALE_DAYS * 24 * 60 * 60 * 1000
		const trajectoryMaxBytes = SWEEP_TRAJECTORY_MAX_MB * 1024 * 1024
		const trajectoryKeepBytes = SWEEP_TRAJECTORY_KEEP_MB * 1024 * 1024
		const lockOrphanMs = SWEEP_LOCK_ORPHAN_MIN * 60 * 1000

		for (const agentId of agents) {
			const sessionsDir = path.join(base, agentId, "sessions")
			let entries: string[]
			try { entries = fs.readdirSync(sessionsDir) } catch { continue }

			// Group checkpoint files by base sessionId
			const checkpointMap = new Map<string, string[]>()
			for (const name of entries) {
				const m = name.match(/^(.+?)\.checkpoint\.\d+\.jsonl$/)
				if (m) {
					const arr = checkpointMap.get(m[1]) || []
					arr.push(name)
					checkpointMap.set(m[1], arr)
				}
			}

			for (const name of entries) {
				const fp = path.join(sessionsDir, name)
				let st: fs.Stats
				try { st = fs.statSync(fp) } catch { continue }
				const age = Date.now() - st.mtimeMs

				// .deleted.* and .reset.* files
				if (name.match(/\.deleted\.\d+\.jsonl(\.lock)?$/) || name.match(/\.reset\.\d+\.jsonl(\.lock)?$/)) {
					if (age > staleMs) {
						try { fs.unlinkSync(fp); deleted++ } catch (e) { console.warn("[taas-affinity] trash sweep: failed to delete", fp, e) }
					}
					continue
				}

				// .checkpoint files — handled in batch below
				if (name.match(/\.checkpoint\.\d+\.jsonl$/)) continue

				// .trajectory.jsonl oversized
				if (name.endsWith(".trajectory.jsonl") && st.size > trajectoryMaxBytes) {
					try {
						const fh = fs.openSync(fp, "r")
						const keepFrom = Math.max(0, st.size - trajectoryKeepBytes)
						const buf = Buffer.alloc(st.size - keepFrom)
						fs.readSync(fh, buf, 0, buf.length, keepFrom)
						fs.closeSync(fh)
						// Find first newline to avoid partial line
						let nlIdx = buf.indexOf(10) // \n
						const dataBuf = nlIdx >= 0 ? buf.slice(nlIdx + 1) : buf
						// Backup original
						const bakPath = fp + ".pre-truncate-" + Date.now() + ".bak"
						fs.renameSync(fp, bakPath)
						fs.writeFileSync(fp, dataBuf)
						truncated++
					} catch (e) { console.warn("[taas-affinity] trash sweep: failed to truncate", fp, e) }
					continue
				}

				// .lock files — orphan detection
				if (name.endsWith(".jsonl.lock")) {
					if (age > lockOrphanMs) {
						try {
							const content = fs.readFileSync(fp, "utf8").trim()
							const pidMatch = content.match(/^\d+/)
							if (pidMatch) {
								const pid = parseInt(pidMatch[0], 10)
								if (!fs.existsSync("/proc/" + pid)) {
									fs.unlinkSync(fp); orphanedLocks++
								}
							} else {
								fs.unlinkSync(fp); orphanedLocks++
							}
						} catch (e) { console.warn("[taas-affinity] trash sweep: failed to process lock", fp, e) }
					}
					continue
				}
			}

			// Prune excess checkpoints per session
			for (const [baseSessionId, files] of checkpointMap) {
				const sorted = files
					.map(f => ({ f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
					.sort((a, b) => b.mtime - a.mtime)
				// Remove beyond KEEP limit
				for (let i = SWEEP_CHECKPOINT_KEEP; i < sorted.length; i++) {
					const fp = path.join(sessionsDir, sorted[i].f)
					try { fs.unlinkSync(fp); deleted++ } catch (e) { console.warn("[taas-affinity] trash sweep: failed to delete checkpoint", fp, e) }
				}
				// Remove any stale checkpoints
				for (const entry of sorted) {
					const age2 = Date.now() - entry.mtime
					if (age2 > staleMs) {
						const fp = path.join(sessionsDir, entry.f)
						try { fs.unlinkSync(fp); deleted++ } catch (e) { console.warn("[taas-affinity] trash sweep: failed to delete stale checkpoint", fp, e) }
					}
				}
			}
		}
	} catch (e) {
		console.warn("[taas-affinity] trash sweep error", e)
	} finally {
		sweepInProgress = false
		console.info("[taas-affinity] trash sweep: deleted=" + deleted + " truncated=" + truncated + " orphaned_locks=" + orphanedLocks + " elapsed=" + (Date.now() - t0) + "ms")
	}
}

// ── Stuck-run status writer ──────────────────────────────────────────────────
interface RunState {
	agentId: string
	sessionUuid: string
	sessionKey: string
	lockMtime: number
	idleMs: number
	state: "active" | "warn" | "stuck" | "zombie"
	pid: number | null
	pidAlive: boolean | null
}

interface RunsStatus {
	generatedAt: number
	thresholds: { warnMs: number; stuckMs: number; zombieMs: number }
	counts: { active: number; warn: number; stuck: number; zombie: number }
	runs: RunState[]
}

let statusInProgress = false

function writeRunStatus(agentsDir?: string, statusPath?: string): void {
	if (statusInProgress) return
	statusInProgress = true
	try {
		const base = agentsDir || path.join(os.homedir(), ".openclaw", "agents")
		const outPath = statusPath || STATUS_PATH
		let agents: string[]
		try { agents = fs.readdirSync(base) } catch { agents = [] }

		const runs: RunState[] = []

		for (const agentId of agents) {
			const sessionsDir = path.join(base, agentId, "sessions")
			let entries: string[]
			try { entries = fs.readdirSync(sessionsDir) } catch { continue }

			// Try to read identity.json for mainKey
			let mainKey: string | null = null
			try {
				const idJson = fs.readFileSync(path.join(base, agentId, "agent", "identity.json"), "utf8")
				const parsed = JSON.parse(idJson)
				if (typeof parsed.mainKey === "string") mainKey = parsed.mainKey
			} catch { /* no identity file */ }

			// Build main session UUID from mainKey
			let mainUuid: string | null = null
			if (mainKey) {
				// mainKey format like "agent:<id>:main" => no UUID, or "agent:<id>:session:<uuid>"
				// But for the main session, it's typically "agent:<id>:main"
				// We'll compare by checking if sessionUuid appears in mainKey
				const parts = mainKey.split(":")
				const lastPart = parts[parts.length - 1]
				if (lastPart !== "main" && lastPart.length >= 8) {
					mainUuid = lastPart
				}
			}

			for (const name of entries) {
				if (!name.endsWith(".jsonl.lock")) continue
				const sessionUuid = name.replace(/\.jsonl\.lock$/, "")
				const fp = path.join(sessionsDir, name)
				let st: fs.Stats
				try { st = fs.statSync(fp) } catch { continue }

				const lockMtime = st.mtimeMs
				const idleMs = Date.now() - lockMtime

				let state: RunState["state"]
				if (idleMs < STATUS_WARN_MS) state = "active"
				else if (idleMs < STATUS_STUCK_MS) state = "warn"
				else if (idleMs < STATUS_ZOMBIE_MS) state = "stuck"
				else state = "zombie"

				let pid: number | null = null
				try {
					const content = fs.readFileSync(fp, "utf8").trim()
					const pidMatch = content.match(/^\d+/)
					if (pidMatch) pid = parseInt(pidMatch[0], 10)
				} catch { /* empty */ }

				let pidAlive: boolean | null = null
				if (pid !== null) {
					try { pidAlive = fs.existsSync("/proc/" + pid) } catch { pidAlive = null }
				}

				let sessionKey: string
				if (mainKey && sessionUuid === mainUuid) {
					sessionKey = "agent:" + agentId + ":main"
				} else {
					sessionKey = "agent:" + agentId + ":session:" + sessionUuid
				}

				runs.push({ agentId, sessionUuid, sessionKey, lockMtime, idleMs, state, pid, pidAlive })
			}
		}

		runs.sort((a, b) => b.idleMs - a.idleMs)

		const counts = { active: 0, warn: 0, stuck: 0, zombie: 0 }
		for (const r of runs) counts[r.state]++

		const output: RunsStatus = {
			generatedAt: Date.now(),
			thresholds: { warnMs: STATUS_WARN_MS, stuckMs: STATUS_STUCK_MS, zombieMs: STATUS_ZOMBIE_MS },
			counts,
			runs,
		}

		// Atomic write
		const dir = path.dirname(outPath)
		try { fs.mkdirSync(dir, { recursive: true }) } catch { /* may already exist */ }
		const tmpPath = path.join(dir, ".runs-status.tmp." + process.pid)
		fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2))
		fs.renameSync(tmpPath, outPath)
	} catch (e) {
		console.warn("[taas-affinity] runs-status write error", e)
	} finally {
		statusInProgress = false
	}
}

// ── Zombie auto-abort ──────────────────────────────────────────────────────────
let abortCheckInProgress = false

function runAbortCheck(agentsDir?: string): void {
	if (abortCheckInProgress) return
	abortCheckInProgress = true
	try {
		const base = agentsDir || path.join(os.homedir(), ".openclaw", "agents")
		let agents: string[]
		try { agents = fs.readdirSync(base) } catch { agents = [] }

		const zombies: Array<{ sessionKey: string; idleMs: number }> = []

		for (const agentId of agents) {
			const sessionsDir = path.join(base, agentId, "sessions")
			let entries: string[]
			try { entries = fs.readdirSync(sessionsDir) } catch { continue }

			let mainKey: string | null = null
			try {
				const idJson = fs.readFileSync(path.join(base, agentId, "agent", "identity.json"), "utf8")
				const parsed = JSON.parse(idJson)
				if (typeof parsed.mainKey === "string") mainKey = parsed.mainKey
			} catch { /* no identity file */ }

			let mainUuid: string | null = null
			if (mainKey) {
				const parts = mainKey.split(":")
				const lastPart = parts[parts.length - 1]
				if (lastPart !== "main" && lastPart.length >= 8) {
					mainUuid = lastPart
				}
			}

			for (const name of entries) {
				if (!name.endsWith(".jsonl.lock")) continue
				const sessionUuid = name.replace(/\.jsonl\.lock$/, "")
				const fp = path.join(sessionsDir, name)
				let st: fs.Stats
				try { st = fs.statSync(fp) } catch { continue }

				const idleMs = Date.now() - st.mtimeMs
				if (idleMs < AUTO_ABORT_THRESHOLD_MS) continue

				let sessionKey: string
				if (mainKey && sessionUuid === mainUuid) {
					sessionKey = "agent:" + agentId + ":main"
				} else {
					sessionKey = "agent:" + agentId + ":session:" + sessionUuid
				}

				zombies.push({ sessionKey, idleMs })
			}
		}

		// When auto-abort is disabled (default), just log candidates
		if (!AUTO_ABORT_ENABLED) {
			if (zombies.length > 0) {
				console.info("[taas-affinity] zombie candidates (auto-abort disabled): " + zombies.length + " runs: " + zombies.map(z => z.sessionKey).join(", "))
			}
			return
		}

		// Auto-abort is enabled — abort each zombie not already aborted in this process
		for (const z of zombies) {
			if (abortedInThisProcess.includes(z.sessionKey)) continue
			// Cap the set at AUTO_ABORT_ABORTED_SET_MAX (FIFO eviction)
			if (abortedInThisProcess.length >= AUTO_ABORT_ABORTED_SET_MAX) {
				abortedInThisProcess.shift()
			}
			abortedInThisProcess.push(z.sessionKey)

			if (AUTO_ABORT_DRY_RUN) {
				console.info("[taas-affinity] auto-abort DRY RUN: would abort sessionKey=" + z.sessionKey + " idleMs=" + z.idleMs)
			} else {
				console.warn("[taas-affinity] auto-aborting zombie run sessionKey=" + z.sessionKey + " idleMs=" + z.idleMs)
				abortRun(z.sessionKey).catch((e: unknown) => {
					console.warn("[taas-affinity] auto-abort failed sessionKey=" + z.sessionKey, e)
				})
			}
		}
	} catch (e) {
		console.warn("[taas-affinity] abort-check error", e)
	} finally {
		abortCheckInProgress = false
	}
}

// ── Background task scheduler ────────────────────────────────────────────────
const backgroundTimers: (NodeJS.Timeout)[] = []

function trackBackgroundTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
	timer.unref?.()
	backgroundTimers.push(timer)
	return timer
}

function startBackgroundTasks(): void {
	// Trash sweeper — randomised initial delay (0-30s) to stagger
	const sweepDelay = Math.floor(Math.random() * 30_000)
	trackBackgroundTimer(setTimeout(() => {
		runTrashSweep()
		trackBackgroundTimer(setInterval(() => runTrashSweep(), SWEEP_INTERVAL_MS))
	}, sweepDelay))

	// Stuck-run status writer — 5s initial delay, then every 30s
	trackBackgroundTimer(setTimeout(() => {
		writeRunStatus()
		trackBackgroundTimer(setInterval(() => writeRunStatus(), STATUS_INTERVAL_MS))
	}, 5_000))

	// Zombie auto-abort — 10s initial delay, then every AUTO_ABORT_CHECK_INTERVAL_MS
	trackBackgroundTimer(setTimeout(() => {
		runAbortCheck()
		trackBackgroundTimer(setInterval(() => runAbortCheck(), AUTO_ABORT_CHECK_INTERVAL_MS))
	}, 10_000))
}

const LAST_ROUTE_LIMIT = 256
const lastRouteBySessionId = new Map<string, AutorouterCapture>()
const lastRouteByAgentId = new Map<string, AutorouterCapture>()

function pruneLastRouteMap(): void {
	if (lastRouteBySessionId.size <= LAST_ROUTE_LIMIT) return
	// Drop oldest entries by capturedAt ascending until we're back under the cap.
	const entries = [...lastRouteBySessionId.entries()].sort(
		(a, b) => a[1].capturedAt - b[1].capturedAt
	)
	const toDrop = entries.length - LAST_ROUTE_LIMIT
	for (let i = 0; i < toDrop; i++) {
		lastRouteBySessionId.delete(entries[i][0])
	}
	if (lastRouteByAgentId.size <= LAST_ROUTE_LIMIT) return
	const aEntries = [...lastRouteByAgentId.entries()].sort(
		(a, b) => a[1].capturedAt - b[1].capturedAt
	)
	const aDrop = aEntries.length - LAST_ROUTE_LIMIT
	for (let i = 0; i < aDrop; i++) {
		lastRouteByAgentId.delete(aEntries[i][0])
	}
}

/**
 * Derive a stable agent identifier from the OpenClaw runtime context. Prefers
 * explicit env vars set by the gateway for sub-agents (OPENCLAW_AGENT_ID /
 * OPENCLAW_RUN_ID), then falls back to the trailing path segment of agentDir
 * or workspaceDir (e.g. /home/u/.openclaw/workspace-new-agent-3 -> "new-agent-3",
 * /home/u/.openclaw/workspace -> "main").
 */
function deriveAgentIdForCapture(
	ctx: { agentDir?: string; workspaceDir?: string }
): string | null {
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

function captureAutorouterFromHeaders(
	sessionId: string,
	headers: Record<string, string>,
	agentId: string | null
): void {
	// Header names from TaaS proxy are emitted in canonical "X-TaaS-*" form
	// but Node/undici lowercases incoming response headers. Read case-insensitively.
	const lowered: Record<string, string> = {}
	for (const [k, v] of Object.entries(headers)) {
		if (typeof v === "string") lowered[k.toLowerCase()] = v
	}
	const autorouted = lowered["x-taas-autorouted"]
	if (autorouted !== "true") return // ignore non-autorouted responses
	const capture: AutorouterCapture = {
		sessionId,
		capturedAt: Date.now(),
		autorouterModel: lowered["x-taas-autorouter-model"] ?? null,
		autorouterAlgo: lowered["x-taas-autorouter-mode"] ?? null,
		autorouterAlgoSource: lowered["x-taas-autorouter-algorithm-source"] ?? null,
		thinkingApplied: lowered["x-taas-thinking-applied"] ?? null,
		routedContextWindow: (() => {
			const raw = lowered["x-taas-routed-context-window"]
			if (!raw) return null
			const n = Number(raw)
			return Number.isFinite(n) && n > 0 ? n : null
		})(),
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

	const { sessionId, source } = resolveSessionId(ctx.workspaceDir)
	const agentIdForCapture = deriveAgentIdForCapture(ctx)
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
		const prevOnResponse = options?.onResponse
		const onResponse: NonNullable<typeof options>["onResponse"] = async (
			response,
			responseModel
		) => {
			try {
				captureAutorouterFromHeaders(
					sessionId,
					response?.headers ?? {},
					agentIdForCapture
				)
			} catch (err) {
				if (isDev) {
					console.debug(
						`[taas-affinity] onResponse capture failed: ${(err as Error)?.message ?? err}`
					)
				}
			}
			if (prevOnResponse) await prevOnResponse(response, responseModel)
		}
		return inner(model, context, { ...options, onPayload, onResponse })
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

		// Expose captured TaaS autorouter metadata to gateway clients (Studio, etc.).
		// The Alien AI Studio polls this after each turn to populate the model/algo/
		// thinking/context-window fields in the AgentChatPanel for cloudsigma/auto and
		// other autorouted requests. See PRD "Alien AI Studio - Auto-Routing Model UX"
		// (Confluence 1901363271).
		if (typeof api.registerGatewayMethod === "function") api.registerGatewayMethod(
			"taas.autorouter.lastRoute",
			async ({ params, respond }) => {
				// Accept either { workspaceDir } (preferred — derives sessionId the
				// same way the wrapper does) or { sessionId } (direct lookup).
				const pp = (params ?? {}) as Record<string, unknown>
				const directAgentId =
					typeof pp.agentId === "string" && pp.agentId.trim()
						? pp.agentId.trim()
						: null
				const directSessionId =
					typeof pp.sessionId === "string" ? pp.sessionId : null
				const workspaceDir =
					typeof pp.workspaceDir === "string" ? pp.workspaceDir : undefined

				// Prefer agent-keyed lookup when the caller supplied an agentId.
				if (directAgentId) {
					const captured = getLastRouteForAgent(directAgentId)
					respond(true, {
						agentId: directAgentId,
						sessionId: captured?.sessionId ?? null,
						capture: captured,
					})
					return
				}

				const resolvedSessionId =
					directSessionId ?? resolveSessionId(workspaceDir).sessionId
				const captured = getLastRouteForSession(resolvedSessionId)
				respond(true, { sessionId: resolvedSessionId, capture: captured })
			},
			{ scope: "operator.read" }
		)

		// Start background tasks (trash sweeper + stuck-run status writer).
		// Timers run for the lifetime of the gateway process.
		try { startBackgroundTasks() } catch (e) { console.warn("[taas-affinity] failed to start background tasks", e) }
	},
	_testExports: {
		runTrashSweep,
		writeRunStatus,
		runAbortCheck,
		setAbortRunFn,
		resetSweepInProgress: () => { sweepInProgress = false },
		resetStatusInProgress: () => { statusInProgress = false },
		resetAbortCheckInProgress: () => { abortCheckInProgress = false },
		clearAbortedInThisProcess: () => { abortedInThisProcess.length = 0 },
		getAbortedInThisProcess: () => [...abortedInThisProcess],
	},
}

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

// Helper: dynamic import with cache bust
async function loadPlugin(env: Record<string, string | undefined> = {}) {
	const oldEnv: Record<string, string | undefined> = {}
	for (const [key, value] of Object.entries(env)) {
		oldEnv[key] = process.env[key]
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	const mod = await import(`../index.ts?bust=${Date.now()}-${Math.random()}`)
	for (const [key, value] of Object.entries(oldEnv)) {
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	return mod
}

// Helper: create a temp agents dir with zombie lock files
function createTempAgentsDir(structure: Array<{
	agentId: string
	sessions: Array<{ uuid: string; mtimeAgeMs: number; pid?: number }>
	identityJson?: Record<string, unknown>
}>) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "taas-abort-test-"))
	for (const { agentId, sessions = [], identityJson } of structure) {
		const sessDir = path.join(base, agentId, "sessions")
		fs.mkdirSync(sessDir, { recursive: true })
		for (const s of sessions) {
			const lockPath = path.join(sessDir, s.uuid + ".jsonl.lock")
			fs.writeFileSync(lockPath, s.pid != null ? String(s.pid) : "12345")
			const newMtime = new Date(Date.now() - s.mtimeAgeMs)
			fs.utimesSync(lockPath, newMtime, newMtime)
		}
		if (identityJson) {
			const agentDir = path.join(base, agentId, "agent")
			fs.mkdirSync(agentDir, { recursive: true })
			fs.writeFileSync(path.join(agentDir, "identity.json"), JSON.stringify(identityJson))
		}
	}
	return base
}

// Collect console output
function collectConsole() {
	const infoLogs: string[] = []
	const warnLogs: string[] = []
	const origInfo = console.info
	const origWarn = console.warn
	console.info = (...args: unknown[]) => { infoLogs.push(args.map(String).join(" ")) }
	console.warn = (...args: unknown[]) => { warnLogs.push(args.map(String).join(" ")) }
	return {
		infoLogs,
		warnLogs,
		restore() {
			console.info = origInfo
			console.warn = origWarn
		},
	}
}

// AC-AUTO-ABORT.1: With auto-abort enabled, classify one zombie session, mock the abort callback, assert it was called with the right sessionKey.
test("AC-AUTO-ABORT.1: auto-abort enabled calls abortRun for zombie session", async () => {
	const mod = await loadPlugin({ TAAS_AFFINITY_AUTO_ABORT_ZOMBIES: "true" })
	const { runAbortCheck, setAbortRunFn, resetAbortCheckInProgress, clearAbortedInThisProcess } = mod.default._testExports

	clearAbortedInThisProcess()
	resetAbortCheckInProgress()

	const aborted: Array<{ sessionKey: string }> = []
	setAbortRunFn(async (sessionKey: string) => {
		aborted.push({ sessionKey })
	})

	// Create a zombie: lock file older than 60 min
	const agentsDir = createTempAgentsDir([{
		agentId: "test-agent",
		sessions: [{ uuid: "abc12345-6789-def0-1234-567890abcdef", mtimeAgeMs: 65 * 60 * 1000 }],
	}])

	const logs = collectConsole()
	try {
		runAbortCheck(agentsDir)
	} finally {
		logs.restore()
	}

	assert.ok(aborted.length === 1, `Expected 1 abort, got ${aborted.length}`)
	assert.match(aborted[0].sessionKey, /^agent:test-agent:session:abc12345/)
})

// AC-AUTO-ABORT.2: With auto-abort disabled (default), classify zombies, assert the abort callback was NOT called and one log line listing candidates.
test("AC-AUTO-ABORT.2: auto-abort disabled logs candidates without aborting", async () => {
	const mod = await loadPlugin({ TAAS_AFFINITY_AUTO_ABORT_ZOMBIES: undefined })
	const { runAbortCheck, setAbortRunFn, resetAbortCheckInProgress, clearAbortedInThisProcess } = mod.default._testExports

	clearAbortedInThisProcess()
	resetAbortCheckInProgress()

	const aborted: string[] = []
	setAbortRunFn(async (sessionKey: string) => {
		aborted.push(sessionKey)
	})

	// Create two zombie lock files
	const agentsDir = createTempAgentsDir([{
		agentId: "main",
		sessions: [
			{ uuid: "deadbeef-0000-0000-0000-000000000001", mtimeAgeMs: 70 * 60 * 1000 },
			{ uuid: "deadbeef-0000-0000-0000-000000000002", mtimeAgeMs: 65 * 60 * 1000 },
		],
	}])

	const logs = collectConsole()
	try {
		runAbortCheck(agentsDir)
	} finally {
		logs.restore()
	}

	assert.equal(aborted.length, 0, "abortRun should NOT be called when auto-abort is disabled")
	// Check that we logged the candidates
	const candidateLog = logs.infoLogs.find(l => l.includes("zombie candidates (auto-abort disabled)"))
	assert.ok(candidateLog, `Expected candidate log, got: ${JSON.stringify(logs.infoLogs)}`)
	assert.ok(candidateLog!.includes("2 runs"), `Expected '2 runs' in log, got: ${candidateLog}`)
})

// AC-AUTO-ABORT.3: Same zombie classified twice in successive ticks → abort callback called ONLY ONCE (idempotence via the in-memory set).
test("AC-AUTO-ABORT.3: idempotent — same zombie only aborted once across two ticks", async () => {
	const mod = await loadPlugin({ TAAS_AFFINITY_AUTO_ABORT_ZOMBIES: "true" })
	const { runAbortCheck, setAbortRunFn, resetAbortCheckInProgress, clearAbortedInThisProcess } = mod.default._testExports

	clearAbortedInThisProcess()
	resetAbortCheckInProgress()

	const aborted: string[] = []
	setAbortRunFn(async (sessionKey: string) => {
		aborted.push(sessionKey)
	})

	const agentsDir = createTempAgentsDir([{
		agentId: "test-agent",
		sessions: [{ uuid: "idempotent-0000-0000-000000000001", mtimeAgeMs: 66 * 60 * 1000 }],
	}])

	// First tick
	resetAbortCheckInProgress()
	runAbortCheck(agentsDir)
	assert.equal(aborted.length, 1, "First tick should abort once")

	// Second tick — same zombie is still there
	resetAbortCheckInProgress()
	runAbortCheck(agentsDir)
	assert.equal(aborted.length, 1, "Second tick should NOT abort again — idempotent")
})

// AC-AUTO-ABORT.4: 1001 distinct zombies all aborted → the in-memory set caps at 1000 entries.
test("AC-AUTO-ABORT.4: aborted set caps at 1000 entries (LRU eviction)", async () => {
	const mod = await loadPlugin({ TAAS_AFFINITY_AUTO_ABORT_ZOMBIES: "true" })
	const { runAbortCheck, setAbortRunFn, resetAbortCheckInProgress, clearAbortedInThisProcess, getAbortedInThisProcess } = mod.default._testExports

	clearAbortedInThisProcess()
	resetAbortCheckInProgress()

	const aborted: string[] = []
	setAbortRunFn(async (sessionKey: string) => {
		aborted.push(sessionKey)
	})

	// Create 1100 zombie lock files (more than the 1000 cap)
	const sessions = []
	for (let i = 0; i < 1100; i++) {
		sessions.push({
			uuid: `zombie-${String(i).padStart(8, "0")}-0000-000000000000`,
			mtimeAgeMs: (61 + (i % 10)) * 60 * 1000, // 61-70 min idle
		})
	}
	const agentsDir = createTempAgentsDir([{
		agentId: "load-agent",
		sessions,
	}])

	resetAbortCheckInProgress()
	runAbortCheck(agentsDir)

	// All 1100 should have been passed to abortRun (they're new each time)
	assert.equal(aborted.length, 1100, `Expected 1100 aborted calls, got ${aborted.length}`)

	// The in-memory set should be capped at 1000
	const set = getAbortedInThisProcess()
	assert.ok(set.length <= 1000 && set.length > 0, `Expected set <= 1000, got ${set.length}`)
})

// Cleanup temp dirs (node:test handles most, but ensure)
test("AC-AUTO-ABORT.5: dry-run mode logs but does not call abortRun", async () => {
	const mod = await loadPlugin({
		TAAS_AFFINITY_AUTO_ABORT_ZOMBIES: "true",
		TAAS_AFFINITY_AUTO_ABORT_DRY_RUN: "true",
	})
	const { runAbortCheck, setAbortRunFn, resetAbortCheckInProgress, clearAbortedInThisProcess } = mod.default._testExports

	clearAbortedInThisProcess()
	resetAbortCheckInProgress()

	const aborted: string[] = []
	setAbortRunFn(async (sessionKey: string) => {
		aborted.push(sessionKey)
	})

	const agentsDir = createTempAgentsDir([{
		agentId: "dry-agent",
		sessions: [{ uuid: "dryrun-test-0000-0000-000000000001", mtimeAgeMs: 65 * 60 * 1000 }],
	}])

	const logs = collectConsole()
	try {
		runAbortCheck(agentsDir)
	} finally {
		logs.restore()
	}

	assert.equal(aborted.length, 0, "dry-run should NOT call abortRun")
	const dryLog = logs.infoLogs.find(l => l.includes("auto-abort DRY RUN"))
	assert.ok(dryLog, `Expected DRY RUN log, got: ${JSON.stringify(logs.infoLogs)}`)
})

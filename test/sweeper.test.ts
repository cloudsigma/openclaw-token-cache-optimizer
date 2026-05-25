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

// Helper: create a temp agents dir with specified structure
function createTempAgentsDir(structure: {
	agentId: string
	files: Array<{ name: string; content?: string; sizeKb?: number; mtimeAgeMs?: number }>
	identityJson?: Record<string, unknown>
}[]) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "taas-sweep-test-"))
	for (const { agentId, files = [], identityJson } of structure) {
		const sessDir = path.join(base, agentId, "sessions")
		fs.mkdirSync(sessDir, { recursive: true })
		for (const f of files) {
			const fp = path.join(sessDir, f.name)
			if (f.sizeKb) {
				const data = "x".repeat(f.sizeKb * 1024)
				fs.writeFileSync(fp, data)
			} else {
				fs.writeFileSync(fp, f.content || "test content for " + f.name)
			}
			if (f.mtimeAgeMs) {
				const newMtime = new Date(Date.now() - f.mtimeAgeMs)
				fs.utimesSync(fp, newMtime, newMtime)
			}
		}
		if (identityJson) {
			const agentDir = path.join(base, agentId, "agent")
			fs.mkdirSync(agentDir, { recursive: true })
			fs.writeFileSync(path.join(agentDir, "identity.json"), JSON.stringify(identityJson))
		}
	}
	return base
}

// AC-SWEEP.1: full sweep logic
test("AC-SWEEP.1: sweeper deletes stale .deleted, keeps fresh, prunes checkpoints, truncates trajectory, removes orphan lock", async () => {
	const mod = await loadPlugin({
		TAAS_AFFINITY_SWEEP_STALE_DAYS: "7",
		TAAS_AFFINITY_SWEEP_TRAJECTORY_MAX_MB: "50",
		TAAS_AFFINITY_SWEEP_TRAJECTORY_KEEP_MB: "10",
		TAAS_AFFINITY_SWEEP_LOCK_ORPHAN_MIN: "60",
		TAAS_AFFINITY_SWEEP_CHECKPOINT_KEEP: "3",
	})
	const { runTrashSweep, resetSweepInProgress } = mod.default._testExports

	const tmpDir = createTempAgentsDir([
		{
			agentId: "test-agent",
			files: [
				// stale deleted (8 days old) -> should be removed
				{ name: "abc.deleted.123.jsonl", mtimeAgeMs: 8 * 24 * 60 * 60 * 1000 },
				// fresh deleted (1 day old) -> should be kept
				{ name: "def.deleted.456.jsonl", mtimeAgeMs: 1 * 24 * 60 * 60 * 1000 },
				// 5 checkpoint files for same session (keep newest 3)
				{ name: "sess1.checkpoint.100.jsonl", mtimeAgeMs: 5 * 24 * 60 * 60 * 1000 },
				{ name: "sess1.checkpoint.200.jsonl", mtimeAgeMs: 4 * 24 * 60 * 60 * 1000 },
				{ name: "sess1.checkpoint.300.jsonl", mtimeAgeMs: 3 * 24 * 60 * 60 * 1000 },
				{ name: "sess1.checkpoint.400.jsonl", mtimeAgeMs: 2 * 24 * 60 * 60 * 1000 },
				{ name: "sess1.checkpoint.500.jsonl", mtimeAgeMs: 1 * 24 * 60 * 60 * 1000 },
				// normal file -> should be untouched
				{ name: "normal.jsonl", mtimeAgeMs: 0 },
			],
		},
	])

	const sessDir = path.join(tmpDir, "test-agent", "sessions")

	// Create a large trajectory file (~60MB -> will be truncated)
	const trajPath = path.join(sessDir, "big.trajectory.jsonl")
	const lineObj = JSON.stringify({ type: "msg", content: "x".repeat(200) }) + "\n"
	const lineSize = Buffer.byteLength(lineObj)
	const targetLines = Math.ceil((60 * 1024 * 1024) / lineSize)
	const trajFd = fs.openSync(trajPath, "w")
	for (let i = 0; i < targetLines; i++) {
		fs.writeSync(trajFd, lineObj)
	}
	fs.closeSync(trajFd)
	// Make it old so mtime check passes
	fs.utimesSync(trajPath, new Date(Date.now() - 60000), new Date(Date.now() - 60000))

	// Orphaned lock with bogus PID (old enough)
	const lockPath = path.join(sessDir, "run1.jsonl.lock")
	fs.writeFileSync(lockPath, "99999")
	fs.utimesSync(lockPath, new Date(Date.now() - 120 * 60 * 1000), new Date(Date.now() - 120 * 60 * 1000))

	// Run sweep
	resetSweepInProgress()
	runTrashSweep(tmpDir)

	// Assert: stale .deleted should be removed
	assert.ok(!fs.existsSync(path.join(sessDir, "abc.deleted.123.jsonl")), "stale .deleted removed")
	// Assert: fresh .deleted should be kept
	assert.ok(fs.existsSync(path.join(sessDir, "def.deleted.456.jsonl")), "fresh .deleted kept")
	// Assert: only 3 newest checkpoints remain (checkpoint.300, .400, .500)
	assert.ok(!fs.existsSync(path.join(sessDir, "sess1.checkpoint.100.jsonl")), "oldest checkpoint removed")
	assert.ok(!fs.existsSync(path.join(sessDir, "sess1.checkpoint.200.jsonl")), "second-oldest checkpoint removed")
	assert.ok(fs.existsSync(path.join(sessDir, "sess1.checkpoint.300.jsonl")), "checkpoint 300 kept")
	assert.ok(fs.existsSync(path.join(sessDir, "sess1.checkpoint.400.jsonl")), "checkpoint 400 kept")
	assert.ok(fs.existsSync(path.join(sessDir, "sess1.checkpoint.500.jsonl")), "checkpoint 500 kept")
	// Assert: trajectory was truncated + backup created
	assert.ok(fs.existsSync(trajPath), "trajectory file still exists")
	const newStat = fs.statSync(trajPath)
	assert.ok(newStat.size < 60 * 1024 * 1024, "trajectory was truncated (smaller than original)")
	assert.ok(newStat.size > 0, "trajectory is not empty")
	// Check backup file exists
	const bakFiles = fs.readdirSync(sessDir).filter(f => f.startsWith("big.trajectory.jsonl.pre-truncate-"))
	assert.ok(bakFiles.length === 1, "exactly one backup file created")
	// Assert: orphaned lock removed
	assert.ok(!fs.existsSync(lockPath), "orphaned lock removed")
	// Assert: normal file untouched
	assert.ok(fs.existsSync(path.join(sessDir, "normal.jsonl")), "normal file untouched")

	// Cleanup
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

// AC-SWEEP.2: sweeper no-op when called twice within interval
test("AC-SWEEP.2: sweeper runs correctly on fresh call after reset", async () => {
	const mod = await loadPlugin()
	const { runTrashSweep, resetSweepInProgress } = mod.default._testExports

	const tmpDir = createTempAgentsDir([{
		agentId: "noop-agent",
		files: [
			{ name: "stale.deleted.999.jsonl", mtimeAgeMs: 8 * 24 * 60 * 60 * 1000 },
		],
	}])

	const sessDir = path.join(tmpDir, "noop-agent", "sessions")
	const stalePath = path.join(sessDir, "stale.deleted.999.jsonl")

	// First sweep should work
	resetSweepInProgress()
	runTrashSweep(tmpDir)
	assert.ok(!fs.existsSync(stalePath), "stale file deleted in first sweep")

	// Recreate for second sweep
	fs.writeFileSync(stalePath, "should also be deleted")
	fs.utimesSync(stalePath, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), new Date(Date.now() - 8 * 24 * 60 * 60 * 1000))

	resetSweepInProgress()
	runTrashSweep(tmpDir)
	assert.ok(!fs.existsSync(stalePath), "stale file also deleted in second sweep")

	fs.rmSync(tmpDir, { recursive: true, force: true })
})

// AC-STATUS.1: stuck-run status classification
test("AC-STATUS.1: status writer classifies locks as active/warn/stuck/zombie", async () => {
	const mod = await loadPlugin()
	const { writeRunStatus, resetStatusInProgress } = mod.default._testExports

	const tmpDir = createTempAgentsDir([
		{
			agentId: "agent-a",
			files: [
				// Fresh lock (1 min old) -> active
				{ name: "fresh.jsonl.lock", content: "12345", mtimeAgeMs: 1 * 60 * 1000 },
				// Warn lock (6 min old) -> warn
				{ name: "warn-sess.jsonl.lock", content: "23456", mtimeAgeMs: 6 * 60 * 1000 },
			],
		},
		{
			agentId: "agent-b",
			files: [
				// Stuck lock (20 min old) -> stuck
				{ name: "stuck.jsonl.lock", content: "34567", mtimeAgeMs: 20 * 60 * 1000 },
			],
		},
		{
			agentId: "agent-c",
			files: [
				// Zombie lock (70 min old) -> zombie
				{ name: "zombie.jsonl.lock", content: "45678", mtimeAgeMs: 70 * 60 * 1000 },
			],
		},
	])

	const statusPath = path.join(os.tmpdir(), "runs-status-test1-" + Date.now() + ".json")

	resetStatusInProgress()
	writeRunStatus(tmpDir, statusPath)

	const content = fs.readFileSync(statusPath, "utf8")
	const status = JSON.parse(content)

	// Assert structure
	assert.ok(typeof status.generatedAt === "number", "generatedAt is number")
	assert.deepEqual(Object.keys(status.thresholds).sort(), ["stuckMs", "warnMs", "zombieMs"])
	assert.deepEqual(Object.keys(status.counts).sort(), ["active", "stuck", "warn", "zombie"])

	// Assert counts
	assert.equal(status.counts.active, 1, "1 active")
	assert.equal(status.counts.warn, 1, "1 warn")
	assert.equal(status.counts.stuck, 1, "1 stuck")
	assert.equal(status.counts.zombie, 1, "1 zombie")

	// Assert 4 runs total
	assert.equal(status.runs.length, 4, "4 runs total")

	// Assert sorted by idleMs descending (worst offenders first)
	for (let i = 1; i < status.runs.length; i++) {
		assert.ok(status.runs[i - 1].idleMs >= status.runs[i].idleMs, "sorted by idleMs desc")
	}

	// Check states
	const states = status.runs.map((r: any) => r.state).sort()
	assert.deepEqual(states, ["active", "stuck", "warn", "zombie"])

	// Check each run has expected fields
	for (const r of status.runs) {
		assert.ok(typeof r.agentId === "string", "agentId is string")
		assert.ok(typeof r.sessionUuid === "string", "sessionUuid is string")
		assert.ok(typeof r.sessionKey === "string", "sessionKey is string")
		assert.ok(typeof r.lockMtime === "number", "lockMtime is number")
		assert.ok(typeof r.idleMs === "number", "idleMs is number")
		assert.ok(["active", "warn", "stuck", "zombie"].includes(r.state), "valid state")
		assert.ok(typeof r.pid === "number" || r.pid === null, "pid is number or null")
		assert.ok(typeof r.pidAlive === "boolean" || r.pidAlive === null, "pidAlive is boolean or null")
	}

	fs.rmSync(tmpDir, { recursive: true, force: true })
	fs.unlinkSync(statusPath)
})

// AC-STATUS.2: no lock files -> empty state
test("AC-STATUS.2: no lock files produces valid JSON with empty runs and zero counts", async () => {
	const mod = await loadPlugin()
	const { writeRunStatus, resetStatusInProgress } = mod.default._testExports

	// Empty agents dir
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taas-status-empty-"))
	fs.mkdirSync(path.join(tmpDir, "some-agent", "sessions"), { recursive: true })

	const statusPath = path.join(os.tmpdir(), "runs-status-empty-" + Date.now() + ".json")

	resetStatusInProgress()
	writeRunStatus(tmpDir, statusPath)

	const content = fs.readFileSync(statusPath, "utf8")
	const status = JSON.parse(content)

	assert.equal(status.counts.active, 0)
	assert.equal(status.counts.warn, 0)
	assert.equal(status.counts.stuck, 0)
	assert.equal(status.counts.zombie, 0)
	assert.ok(Array.isArray(status.runs))
	assert.equal(status.runs.length, 0)
	assert.ok(typeof status.generatedAt === "number")

	fs.rmSync(tmpDir, { recursive: true, force: true })
	fs.unlinkSync(statusPath)
})

// AC-STATUS.3: atomic write produces valid JSON
test("AC-STATUS.3: atomic write produces valid JSON even with rapid successive writes", async () => {
	const mod = await loadPlugin()
	const { writeRunStatus, resetStatusInProgress } = mod.default._testExports

	const tmpDir = createTempAgentsDir([{
		agentId: "atomic-agent",
		files: [
			{ name: "lock1.jsonl.lock", content: "11111", mtimeAgeMs: 1000 },
		],
	}])

	const statusPath = path.join(os.tmpdir(), "runs-status-atomic-" + Date.now() + ".json")

	// Write twice in rapid succession
	resetStatusInProgress()
	writeRunStatus(tmpDir, statusPath)
	resetStatusInProgress()
	writeRunStatus(tmpDir, statusPath)

	// Both writes should produce valid JSON
	const content = fs.readFileSync(statusPath, "utf8")
	const status = JSON.parse(content)
	assert.ok(status.generatedAt, "has generatedAt")
	assert.ok(Array.isArray(status.runs), "has runs array")

	fs.rmSync(tmpDir, { recursive: true, force: true })
	fs.unlinkSync(statusPath)
})

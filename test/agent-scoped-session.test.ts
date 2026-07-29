import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../index.ts"

const internals = (plugin as unknown as { __test__?: Record<string, unknown> }).__test__

type Resolve = (
	workspaceDir?: string,
	sessionId?: unknown,
	agentId?: unknown,
) => { sessionId: string; identityMode: string; source: string } | null

test("agent id alone does not fabricate a conversation identity", () => {
	assert.ok(internals)
	const resolve = internals!.resolveSessionIdentity as Resolve
	assert.equal(resolve("/home/x/.openclaw/workspace", undefined, "main"), null)
})

test("workspace and agent scopes do not merge unrelated conversations", () => {
	const resolve = internals!.resolveSessionIdentity as Resolve
	assert.equal(resolve("/ws/a", undefined, "main"), null)
	assert.equal(resolve("/ws/b", undefined, "main"), null)
})

test("a native session id always takes precedence", () => {
	const resolve = internals!.resolveSessionIdentity as Resolve
	const r = resolve("/home/x/workspace", "agent:main:main", "main")
	assert.equal(r!.identityMode, "native")
	assert.equal(r!.sessionId, "agent:main:main")
})

test("no session and no agent yields no fabricated identity", () => {
	const resolve = internals!.resolveSessionIdentity as Resolve
	assert.equal(resolve("/home/x/workspace", undefined, undefined), null)
})

import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../index.ts"

/**
 * OpenClaw does not include `sessionId` in the wrapStreamFn context for the
 * openai-completions transport (see extra-params: it passes config, agentDir,
 * workspaceDir, agentId, provider, modelId, extraParams, thinkingLevel, model,
 * streamFn). That lane carries all agent traffic, so the plugin previously
 * injected nothing and TaaS minted a fresh session id per request:
 *
 *   2248 OpenAI session records -> 2247 minted, 1 caller-supplied
 *   272 requests -> 272 distinct session ids -> continuity 0%
 *
 * `agentId` is present and stable for the conversation, so it is a valid
 * affinity key when no native session id exists.
 */

const internals = (plugin as unknown as { __test__?: Record<string, unknown> }).__test__

type Resolve = (
	workspaceDir?: string,
	sessionId?: unknown,
	agentId?: unknown
) => { sessionId: string; identityMode: string; source: string } | null

test("agent id yields a stable session identity when no native session id exists", () => {
	assert.ok(internals)
	const resolve = internals!.resolveSessionIdentity as Resolve
	const ws = "/home/x/.openclaw/workspace"

	const a = resolve(ws, undefined, "main")
	const b = resolve(ws, undefined, "main")

	assert.ok(a, "must resolve an identity from agentId alone")
	assert.equal(a!.sessionId, b!.sessionId, "identity must be stable across requests")
	assert.equal(a!.identityMode, "agent_scoped")
	assert.equal(a!.source, "openclaw:ctx.agentId")
})

test("different agents get different identities", () => {
	const resolve = internals!.resolveSessionIdentity as Resolve
	const ws = "/home/x/.openclaw/workspace"
	assert.notEqual(resolve(ws, undefined, "main")!.sessionId, resolve(ws, undefined, "other")!.sessionId)
})

test("identity is workspace scoped so same-named agents do not collide", () => {
	const resolve = internals!.resolveSessionIdentity as Resolve
	assert.notEqual(
		resolve("/ws/a", undefined, "main")!.sessionId,
		resolve("/ws/b", undefined, "main")!.sessionId
	)
})

test("a native session id always takes precedence", () => {
	const resolve = internals!.resolveSessionIdentity as Resolve
	const r = resolve("/home/x/workspace", "agent:main:main", "main")
	assert.equal(r!.identityMode, "native")
	assert.equal(r!.sessionId, "agent:main:main")
})

test("no session and no agent still yields no fabricated identity", () => {
	const resolve = internals!.resolveSessionIdentity as Resolve
	assert.equal(resolve("/home/x/workspace", undefined, undefined), null)
})

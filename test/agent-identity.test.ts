import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../index.ts"

/**
 * TaaS requires BOTH an agent id and a session id before it trusts a
 * caller-supplied identity:
 *
 *   identity_present = session_present && agent_present
 *
 * In production every request logged
 * `fallback_reason=missing_agent_and_session`, so TaaS discarded the supplied
 * identity and minted a fresh session per request. That destroyed affinity and
 * pinned continuity at 0%.
 */

const internals = (plugin as unknown as { __test__?: Record<string, unknown> }).__test__

test("agent identity is derived from an OpenClaw session key when no dir hint exists", () => {
	assert.ok(internals, "plugin must expose test internals")
	const resolveAgentIdentity = internals!.resolveAgentIdentity as (
		ctx: { agentDir?: string; workspaceDir?: string },
		sessionId: string | null | undefined
	) => string | null

	// No agentDir/workspaceDir, which is the production case for the
	// openai-completions transport.
	assert.equal(resolveAgentIdentity({}, "agent:main:main"), "main")
	assert.equal(resolveAgentIdentity({}, "agent:new-agent-3:main"), "new-agent-3")
	assert.equal(
		resolveAgentIdentity({}, "agent:main:subagent:1ab99fc0-55fb-4b22-a5b3-c4223ef63d6d"),
		"main"
	)
})

test("agent identity still prefers an explicit directory hint", () => {
	const resolveAgentIdentity = internals!.resolveAgentIdentity as (
		ctx: { agentDir?: string; workspaceDir?: string },
		sessionId: string | null | undefined
	) => string | null

	assert.equal(resolveAgentIdentity({ workspaceDir: "/home/x/workspace" }, "agent:zzz:main"), "main")
	assert.equal(
		resolveAgentIdentity({ workspaceDir: "/home/x/workspace-billing" }, "agent:zzz:main"),
		"billing"
	)
})

test("no session identity yields no fabricated agent identity", () => {
	const resolveAgentIdentity = internals!.resolveAgentIdentity as (
		ctx: { agentDir?: string; workspaceDir?: string },
		sessionId: string | null | undefined
	) => string | null

	assert.equal(resolveAgentIdentity({}, null), null)
	assert.equal(resolveAgentIdentity({}, undefined), null)
	assert.equal(resolveAgentIdentity({}, ""), null)
})

test("correlation envelope carries agent_id so TaaS sees a complete identity", () => {
	const buildCorrelationMetadata = internals!.buildCorrelationMetadata as (
		sessionId: string,
		source: string,
		sourceHint: string,
		ctx: unknown,
		agentId: string | null
	) => Record<string, unknown>

	const meta = buildCorrelationMetadata(
		"agent:main:main",
		"openclaw:ctx.sessionId",
		"stateDir:/home/x/.openclaw",
		{ provider: "cloudsigma", modelId: "gpt-5.6-sol" },
		"main"
	)

	assert.equal(meta.session_id, "agent:main:main")
	assert.equal(meta.agent_id, "main")
	// TaaS classifies declared_plugin from a source starting with "openclaw-".
	assert.ok(String(meta.source).startsWith("openclaw-"))
	assert.ok(meta.plugin_version)
})

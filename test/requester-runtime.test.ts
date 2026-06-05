import assert from "node:assert/strict"
import { test } from "node:test"

async function loadPlugin(env: Record<string, string | undefined> = {}) {
	const oldEnv: Record<string, string | undefined> = {}
	for (const [key, value] of Object.entries(env)) {
		oldEnv[key] = process.env[key]
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	const mod = await import(`../index.ts?cacheBust=${Date.now()}-${Math.random()}`)
	return {
		plugin: mod.default,
		restore() {
			for (const [key, value] of Object.entries(oldEnv)) {
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
		},
	}
}

function captureProvider(plugin: any) {
	let provider: any
	plugin.register({ registerProvider(candidate: any) { provider = candidate } })
	return provider
}

async function runPayload(provider: any, payload: any, ctxExtra: Record<string, unknown> = {}) {
	let captured: any
	const streamFn = (_model: any, _context: any, options: any) => options.onPayload(payload, _model).then((result: any) => {
		captured = result
		return result
	})
	const wrapper = provider.wrapStreamFn({
		provider: "cloudsigma",
		modelId: "cloudsigma/auto",
		workspaceDir: process.cwd(),
		model: { id: "cloudsigma/auto", baseUrl: ctxExtra.baseUrl },
		streamFn,
		...ctxExtra,
	})
	await wrapper("model", { messages: [] }, {})
	return captured
}

test("Direction-2 metadata has no requester bridge descriptors or raw local paths", async () => {
	const { plugin, restore } = await loadPlugin({
		TAAS_REQUESTER_BRIDGE_PLUGIN_ENABLED: "1",
		TAAS_REQUESTER_BRIDGE_LEASE_URL: "http://127.0.0.1:9/internal/requester-bridges/leases",
	})
	try {
		const payload = await runPayload(captureProvider(plugin), { messages: [], metadata: {} })
		const runtime = payload.metadata.requester_runtime
		assert.equal("available_bridges" in runtime, false)
		assert.equal("capture_mode" in runtime, false)
		assert.equal(runtime.tool_execution, "direction_2_gateway")
		assert.equal(runtime.source, "openclaw-taas-affinity")
		assert.equal("workspace_dir" in runtime, false)
		assert.equal("agent_dir" in runtime, false)
		assert.equal("repo_root_hint" in runtime, false)
	} finally {
		restore()
	}
})

test("OpenAI tool declarations pass through untouched", async () => {
	const { plugin, restore } = await loadPlugin()
	try {
		const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]
		const payload = await runPayload(captureProvider(plugin), { messages: [], tools, tool_choice: "auto" })
		assert.equal(payload.tools, tools)
		assert.equal(payload.tool_choice, "auto")
	} finally {
		restore()
	}
})

test("assistant tool_calls and role=tool messages are not intercepted", async () => {
	const { plugin, restore } = await loadPlugin()
	try {
		const messages = [
			{ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "call_1", content: "result" },
		]
		const payload = await runPayload(captureProvider(plugin), { messages })
		assert.equal(payload.messages, messages)
	} finally {
		restore()
	}
})

test("existing affinity metadata is never overwritten", async () => {
	const { plugin, restore } = await loadPlugin()
	try {
		const payload = await runPayload(captureProvider(plugin), {
			messages: [],
			metadata: {
				session_id: "external-session",
				sticky_key: "external-sticky",
				requester_runtime: { source: "caller" },
			},
		})
		assert.equal(payload.metadata.session_id, "external-session")
		assert.equal(payload.metadata.sticky_key, "external-sticky")
		assert.deepEqual(payload.metadata.requester_runtime, { source: "caller" })
	} finally {
		restore()
	}
})

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
	plugin.register({ registerProvider(candidate: any) { provider = candidate }, runtime: { system: { enqueueSystemEvent: () => true, requestHeartbeat: () => {} } } })
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
		const payload = await runPayload(captureProvider(plugin), { messages: [], metadata: {} }, { sessionId: "local-runtime-test" })
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


test("native OpenClaw session IDs pass through unchanged", async () => {
	const { plugin, restore } = await loadPlugin({ OPENCLAW_SESSION_ID: "legacy-env-id" })
	try {
		const provider = captureProvider(plugin)
		const nativeId = "a5add102-d79b-4168-8a2a-6dd75135f73b"
		const payload = await runPayload(provider, { messages: [], metadata: {} }, { sessionId: nativeId })
		assert.equal(payload.metadata.session_id, nativeId)
		assert.equal(payload.metadata.sticky_key, nativeId)
		assert.equal(payload.metadata.requester_runtime.openclaw_session_id, nativeId)
		assert.equal(payload.metadata.requester_runtime.session_identity_scope, "native_openclaw_session")
		assert.equal(payload.metadata.openclaw_correlation.session_id, nativeId)
		const transport = provider.resolveTransportTurnState({ sessionId: nativeId, turnId: "turn-native", attempt: 1 })
		assert.equal(transport.headers["X-Session-Id"], nativeId)
	} finally {
		restore()
	}
})

test("legacy environment identity is generated only when native session ID is unavailable", async () => {
	const { plugin, restore } = await loadPlugin({ OPENCLAW_SESSION_ID: "legacy-env-id" })
	try {
		const provider = captureProvider(plugin)
		const payload = await runPayload(provider, { messages: [], metadata: {} })
		assert.match(payload.metadata.session_id, /^oc:[a-f0-9]{16}$/)
		assert.equal(payload.metadata.requester_runtime.session_identity_scope, "legacy_generated_session")
		const transport = provider.resolveTransportTurnState({ turnId: "turn-legacy", attempt: 1 })
		assert.equal(transport.headers["X-Session-Id"], payload.metadata.session_id)
	} finally {
		restore()
	}
})

test("no session identity means no affinity injection", async () => {
	const { plugin, restore } = await loadPlugin({ OPENCLAW_SESSION_ID: undefined })
	try {
		const provider = captureProvider(plugin)
		const payload = await runPayload(provider, { messages: [], metadata: { existing: true } })
		assert.deepEqual(payload.metadata, { existing: true })
		assert.equal(provider.resolveTransportTurnState({ turnId: "turn-none", attempt: 1 }), null)
	} finally {
		restore()
	}
})


test("privacy-safe affinity stats gateway method exposes counters without identities", async () => {
	const { plugin, restore } = await loadPlugin()
	try {
		const methods = new Map<string, any>()
		plugin.register({
			registerProvider() {},
			registerGatewayMethod(name: string, handler: any) { methods.set(name, handler) },
			runtime: { system: { enqueueSystemEvent: () => true, requestHeartbeat: () => {} } },
		})
		const handler = methods.get("taas.affinity.stats")
		assert.equal(typeof handler, "function")
		let response: any
		await handler({ params: {}, respond(ok: boolean, payload: any) { response = { ok, payload } } })
		assert.equal(response.ok, true)
		assert.equal(response.payload.pluginVersion, "0.12.0")
		assert.equal(response.payload.bridge.ttlMs, 30 * 60 * 1000)
		assert.equal(response.payload.bridge.limit, 1024)
		assert.deepEqual(Object.keys(response.payload.counters).sort(), [
			"ambiguous", "directOptionsSessionId", "expired", "hit", "miss",
		])
		const encoded = JSON.stringify(response)
		assert.equal(encoded.includes("traceId"), false)
		assert.equal(encoded.includes("sessionId"), false)
	} finally {
		restore()
	}
})

test("autorouter override gateway method validates, injects, clears, and stays session-scoped", async () => {
	const { plugin, restore } = await loadPlugin()
	try {
		const methods = new Map<string, any>()
		let provider: any
		plugin.register({
			registerProvider(candidate: any) { provider = candidate },
			registerGatewayMethod(name: string, handler: any) { methods.set(name, handler) },
			runtime: { system: { enqueueSystemEvent: () => true, requestHeartbeat: () => {} } },
		})
		const handler = methods.get("taas.autorouter.setAlgorithm")
		const call = async (params: Record<string, unknown>) => {
			let response: any
			await handler({ params, respond(ok: boolean, payload: any, error: any) { response = { ok, payload, error } } })
			return response
		}

		assert.equal((await call({ sessionId: "session-a", algorithm: "cost" })).ok, true)
		assert.equal(
			provider.resolveTransportTurnState({ sessionId: "session-a", turnId: "turn-a", attempt: 1 }).headers["X-TaaS-Autorouter-Algorithm"],
			"cost",
		)
		assert.equal(
			provider.resolveTransportTurnState({ sessionId: "session-b", turnId: "turn-b", attempt: 1 }).headers["X-TaaS-Autorouter-Algorithm"],
			undefined,
		)
		assert.equal((await call({ sessionId: "session-a", algorithm: "parity_scoring" })).ok, false)
		assert.equal((await call({ sessionId: "session-a", algorithm: null })).ok, true)
		assert.equal(
			provider.resolveTransportTurnState({ sessionId: "session-a", turnId: "turn-c", attempt: 1 }).headers["X-TaaS-Autorouter-Algorithm"],
			undefined,
		)
	} finally {
		restore()
	}
})

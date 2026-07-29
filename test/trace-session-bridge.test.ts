import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../index.ts"

const internals = (plugin as any).__test__ as Record<string, any>
const TRACE_A = { traceId: "11111111111111111111111111111111", spanId: "aaaaaaaaaaaaaaaa" }
const TRACE_B = { traceId: "22222222222222222222222222222222", spanId: "bbbbbbbbbbbbbbbb" }
const TRACE_C = { traceId: "33333333333333333333333333333333", spanId: "cccccccccccccccc" }

function traceparent(trace: { traceId: string; spanId: string }): string {
	return `00-${trace.traceId}-${trace.spanId}-01`
}

function captureProvider(withHook = true) {
	let provider: any
	let modelCallStarted: ((event: unknown, ctx: unknown) => void) | undefined
	const api: any = {
		registerProvider(candidate: any) { provider = candidate },
		registerGatewayMethod() {},
		runtime: { system: { enqueueSystemEvent: () => true, requestHeartbeat: () => {} } },
	}
	if (withHook) {
		api.on = (name: string, handler: (event: unknown, ctx: unknown) => void) => {
			assert.equal(name, "model_call_started")
			modelCallStarted = handler
		}
	}
	;(plugin as any).register(api)
	assert.ok(provider)
	return { provider, modelCallStarted }
}

function createModel(id: string) {
	return {
		provider: "cloudsigma",
		id,
		api: "openai-completions",
		baseUrl: "https://api.cloudsigma.com/ai/v1",
	}
}

async function invoke(
	provider: any,
	modelId: string,
	options: Record<string, unknown>,
	simple = false,
	ctx: Record<string, unknown> = {},
): Promise<any> {
	let payload: any
	const wrapper = (simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn)({
		provider: "cloudsigma",
		modelId,
		workspaceDir: "/workspace/ignored-for-identity",
		agentId: "main",
		streamFn: async (model: unknown, _context: unknown, streamOptions: any) => {
			payload = await streamOptions.onPayload({ messages: [], metadata: {} }, model)
			return payload
		},
		...ctx,
	})
	await wrapper(createModel(modelId), { messages: [] }, options)
	return payload
}

function start(
	hook: ((event: unknown, ctx: unknown) => void) | undefined,
	trace: { traceId: string; spanId: string },
	sessionId?: string,
	extraEvent: Record<string, unknown> = {},
	extraCtx: Record<string, unknown> = {},
) {
	assert.ok(hook)
	hook(
		{ runId: "run-1", callId: "call-1", sessionId, provider: "cloudsigma", model: "model", ...extraEvent },
		{ runId: "run-1", sessionId, trace, ...extraCtx },
	)
}

test.beforeEach(() => {
	internals.traceSessionBridge.clear()
	delete process.env.OPENCLAW_SESSION_ID
})

test("GPT direct options identity has precedence over context and trace bridge", async () => {
	const { provider, modelCallStarted } = captureProvider()
	start(modelCallStarted, TRACE_A, "trace-session")
	const payload = await invoke(provider, "gpt-5.6-sol", {
		sessionId: "options-session",
		headers: { traceparent: traceparent(TRACE_A) },
	}, false, { sessionId: "context-session" })
	assert.equal(payload.metadata.session_id, "options-session")
})

test("Kimi and another generic CloudSigma model resolve exact trace bridge identity", async () => {
	const { provider, modelCallStarted } = captureProvider()
	for (const [modelId, trace, sessionId] of [
		["kimi-k2", TRACE_A, "kimi-session"],
		["glm-5", TRACE_B, "glm-session"],
	] as const) {
		start(modelCallStarted, trace, sessionId)
		const payload = await invoke(provider, modelId, {
			headers: { traceparent: traceparent(trace) },
		})
		assert.equal(payload.metadata.session_id, sessionId, modelId)
		assert.equal(payload.metadata.openclaw_correlation.model_id, modelId, modelId)
	}
})

test("queued model_call_started hook wins the immediate payload-construction race", async () => {
	const { provider, modelCallStarted } = captureProvider()
	queueMicrotask(() => start(modelCallStarted, TRACE_A, "queued-hook-session"))
	const payload = await invoke(provider, "kimi-k2", {
		headers: { traceparent: traceparent(TRACE_A) },
	})
	assert.equal(payload.metadata.session_id, "queued-hook-session")
})

test("simple completion resolves exact trace bridge identity", async () => {
	const { provider, modelCallStarted } = captureProvider()
	start(modelCallStarted, TRACE_A, "simple-trace-session")
	const payload = await invoke(provider, "kimi-k2", {
		headers: { traceparent: traceparent(TRACE_A) },
	}, true)
	assert.equal(payload.metadata.session_id, "simple-trace-session")
})

test("concurrent distinct traces remain isolated", async () => {
	const { provider, modelCallStarted } = captureProvider()
	start(modelCallStarted, TRACE_A, "session-alpha")
	start(modelCallStarted, TRACE_B, "session-beta")
	const [alpha, beta] = await Promise.all([
		invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(TRACE_A) } }),
		invoke(provider, "glm-5", { headers: { traceparent: traceparent(TRACE_B) } }),
	])
	assert.equal(alpha.metadata.session_id, "session-alpha")
	assert.equal(beta.metadata.session_id, "session-beta")
})

test("same exact trace supports retries without consume races", async () => {
	const { provider, modelCallStarted } = captureProvider()
	start(modelCallStarted, TRACE_A, "retry-session")
	const results = await Promise.all([
		invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(TRACE_A) } }),
		invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(TRACE_A) } }),
		invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(TRACE_A) } }),
	])
	assert.deepEqual(results.map((payload) => payload.metadata.session_id), [
		"retry-session",
		"retry-session",
		"retry-session",
	])
})

test("parent and subagent traces preserve distinct authoritative sessions", async () => {
	const { provider, modelCallStarted } = captureProvider()
	start(modelCallStarted, TRACE_A, "agent:main:main")
	start(modelCallStarted, TRACE_B, "agent:main:subagent:child-1")
	const parent = await invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(TRACE_A) } })
	const child = await invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(TRACE_B) } })
	assert.equal(parent.metadata.session_id, "agent:main:main")
	assert.equal(child.metadata.session_id, "agent:main:subagent:child-1")
})

test("malformed, absent, partial, and mismatched trace data fail closed", async () => {
	const { provider, modelCallStarted } = captureProvider()
	start(modelCallStarted, TRACE_A, "must-not-leak")
	const optionCases = [
		{},
		{ headers: {} },
		{ headers: { traceparent: "garbage" } },
		{ headers: { traceparent: `00-${TRACE_A.traceId}-0000000000000000-01` } },
		{ headers: { traceparent: traceparent(TRACE_C) } },
		{ headers: { traceparent: traceparent(TRACE_A), TraceParent: traceparent(TRACE_B) } },
	]
	for (const options of optionCases) {
		const payload = await invoke(provider, "kimi-k2", options)
		assert.deepEqual(payload.metadata, {})
	}

	modelCallStarted?.(
		{ runId: "run", callId: "call", sessionId: "event-session", provider: "cloudsigma", model: "kimi-k2" },
		{ runId: "run", sessionId: "context-session", trace: TRACE_B },
	)
	const ambiguous = await invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(TRACE_B) } })
	assert.deepEqual(ambiguous.metadata, {})
})

test("hook ignores missing authoritative session and malformed trace context", async () => {
	const { provider, modelCallStarted } = captureProvider()
	start(modelCallStarted, TRACE_A, undefined)
	modelCallStarted?.(
		{ runId: "run", callId: "call", sessionId: "event-only-session", provider: "cloudsigma", model: "kimi-k2" },
		{ runId: "run", trace: TRACE_A },
	)
	start(modelCallStarted, { traceId: TRACE_B.traceId, spanId: "bad" }, "session-b")
	for (const trace of [TRACE_A, TRACE_B]) {
		const payload = await invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(trace) } })
		assert.deepEqual(payload.metadata, {})
	}
})

test("trace bridge prunes by TTL and bounded insertion order", () => {
	let now = 1000
	const Bridge = internals.TraceSessionBridge
	const bridge = new Bridge(2, 50, () => now)
	bridge.record("trace-a", "session-a")
	now += 1
	bridge.record("trace-b", "session-b")
	now += 1
	bridge.record("trace-c", "session-c")
	assert.equal(bridge.size, 2)
	assert.equal(bridge.resolve("trace-a"), undefined)
	assert.equal(bridge.resolve("trace-b"), "session-b")
	assert.equal(bridge.resolve("trace-c"), "session-c")
	now += 50
	assert.equal(bridge.resolve("trace-b"), undefined)
	assert.equal(bridge.size, 0)
})

test("duplicate exact trace with conflicting sessions becomes ambiguous", () => {
	const Bridge = internals.TraceSessionBridge
	const bridge = new Bridge(4, 1000, () => 1)
	bridge.record("same-trace", "session-a")
	bridge.record("same-trace", "session-b")
	bridge.record("same-trace", "session-a")
	assert.equal(bridge.resolve("same-trace"), undefined)
})

test("existing metadata remains no-overwrite under trace bridge", async () => {
	const { provider, modelCallStarted } = captureProvider()
	start(modelCallStarted, TRACE_A, "bridge-session")
	let payload: any
	const wrapped = provider.wrapStreamFn({
		provider: "cloudsigma",
		modelId: "kimi-k2",
		streamFn: async (model: unknown, _context: unknown, options: any) => {
			payload = await options.onPayload({
				messages: [],
				metadata: {
					session_id: "external-session",
					sticky_key: "external-sticky",
					requester_runtime: { source: "caller" },
					openclaw_correlation: { source: "caller" },
				},
			}, model)
			return payload
		},
	})
	await wrapped(createModel("kimi-k2"), {}, { headers: { traceparent: traceparent(TRACE_A) } })
	assert.deepEqual(payload.metadata, {
		session_id: "external-session",
		sticky_key: "external-sticky",
		requester_runtime: { source: "caller" },
		openclaw_correlation: { source: "caller" },
	})
})

test("hook unavailable is graceful and direct options.sessionId still works", async () => {
	const { provider, modelCallStarted } = captureProvider(false)
	assert.equal(modelCallStarted, undefined)
	const direct = await invoke(provider, "gpt-5.6-sol", { sessionId: "direct-session" })
	assert.equal(direct.metadata.session_id, "direct-session")
	const noIdentity = await invoke(provider, "kimi-k2", { headers: { traceparent: traceparent(TRACE_A) } })
	assert.deepEqual(noIdentity.metadata, {})
})

test("trace parsers normalize only exact valid W3C correlation", () => {
	const key = `${TRACE_A.traceId}:${TRACE_A.spanId}`
	assert.equal(internals.traceKeyFromContext(TRACE_A), key)
	assert.equal(internals.traceKeyFromTraceparent(traceparent(TRACE_A).toUpperCase()), key)
	assert.equal(internals.traceKeyFromTraceparent(`01-${TRACE_A.traceId}-${TRACE_A.spanId}-01`), undefined)
	assert.equal(internals.traceKeyFromContext({ traceId: TRACE_A.traceId }), undefined)
})

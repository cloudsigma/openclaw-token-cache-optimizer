import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../index.ts"

type RegisteredProvider = {
	wrapStreamFn: (ctx: Record<string, unknown>) => (...args: any[]) => unknown
	wrapSimpleCompletionStreamFn: (ctx: Record<string, unknown>) => (...args: any[]) => unknown
}

function captureProvider(): RegisteredProvider {
	let provider: RegisteredProvider | undefined
	;(plugin as any).register({
		registerProvider(candidate: RegisteredProvider) {
			provider = candidate
		},
		registerGatewayMethod() {},
		runtime: { system: { enqueueSystemEvent: () => true, requestHeartbeat: () => {} } },
	})
	assert.ok(provider)
	return provider
}

function createModel(id: string) {
	return {
		provider: "cloudsigma",
		id,
		api: "openai-completions",
		baseUrl: "https://api.cloudsigma.com/ai/v1",
	}
}

test("invocation options.sessionId overrides wrapper context and drives the whole envelope", async () => {
	const provider = captureProvider()
	let receivedOptions: any
	const wrapped = provider.wrapStreamFn({
		provider: "cloudsigma",
		modelId: "gpt-5.6-sol",
		agentId: "main",
		workspaceDir: "/home/cloudsigma/.openclaw/workspace",
		sessionId: "stale-context-session",
		streamFn: async (model: unknown, _context: unknown, options: any) => {
			receivedOptions = options
			return await options.onPayload({ messages: [], metadata: {} }, model)
		},
	})

	const result: any = await wrapped(createModel("gpt-5.6-sol"), { messages: [] }, {
		sessionId: "native-invocation-session",
	})

	assert.equal(result.metadata.session_id, "native-invocation-session")
	assert.equal(result.metadata.sticky_key, "native-invocation-session")
	assert.equal(result.metadata.requester_runtime.session_key, "native-invocation-session")
	assert.equal(result.metadata.openclaw_correlation.session_id, "native-invocation-session")
	assert.equal(receivedOptions.sessionId, "native-invocation-session")
})

test("managed GPT-5.6 and Kimi openai-completions invocations use options.sessionId", async () => {
	const provider = captureProvider()
	for (const modelId of ["gpt-5.6-sol", "kimi-k2"]) {
		let payload: any
		const wrapped = provider.wrapStreamFn({
			provider: "cloudsigma",
			modelId,
			agentId: "main",
			workspaceDir: "/home/cloudsigma/.openclaw/workspace",
			streamFn: async (model: unknown, _context: unknown, options: any) => {
				payload = await options.onPayload({ messages: [], metadata: {} }, model)
				return payload
			},
		})
		const sessionId = `native-${modelId}`
		await wrapped(createModel(modelId), { messages: [] }, { sessionId })
		assert.equal(payload.metadata.session_id, sessionId, modelId)
		assert.equal(payload.metadata.openclaw_correlation.model_id, modelId, modelId)
	}
})

test("simple completion wrapper uses an invocation sessionId when supplied", async () => {
	const provider = captureProvider()
	assert.equal(provider.wrapSimpleCompletionStreamFn, provider.wrapStreamFn)
	let payload: any
	const wrapped = provider.wrapSimpleCompletionStreamFn({
		provider: "cloudsigma",
		modelId: "gpt-5.6-sol",
		agentId: "main",
		workspaceDir: "/home/cloudsigma/.openclaw/workspace",
		streamFn: async (model: unknown, _context: unknown, options: any) => {
			payload = await options.onPayload({ messages: [], metadata: {} }, model)
			return payload
		},
	})
	await wrapped(createModel("gpt-5.6-sol"), { messages: [] }, {
		sessionId: "simple-native-session",
	})
	assert.equal(payload.metadata.session_id, "simple-native-session")
	assert.equal(payload.metadata.requester_runtime.session_key, "simple-native-session")
})

test("concurrent calls on one wrapper keep payload and response identity isolated", async () => {
	const provider = captureProvider()
	const payloadBarrier = new Map<string, () => void>()
	const payloadReady = new Map<string, Promise<void>>()
	for (const id of ["session-alpha", "session-beta"]) {
		payloadReady.set(id, new Promise<void>((resolve) => payloadBarrier.set(id, resolve)))
	}
	const results = new Map<string, any>()
	const responseCallbacks = new Map<string, string>()
	const wrapped = provider.wrapStreamFn({
		provider: "cloudsigma",
		modelId: "gpt-5.6-sol",
		agentId: "main",
		workspaceDir: "/home/cloudsigma/.openclaw/workspace",
		streamFn: async (model: unknown, _context: unknown, options: any) => {
			const id = options.sessionId as string
			payloadBarrier.get(id)!()
			await Promise.all(payloadReady.values())
			const payload = await options.onPayload({ messages: [], metadata: {} }, model)
			// Cross the calls again before response capture to expose shared mutable state.
			await Promise.resolve()
			await options.onResponse(
				{
					status: 200,
					headers: {
						"x-taas-autorouted": "true",
						"x-taas-autorouter-model": `route-${id}`,
					},
				},
				model,
			)
			results.set(id, payload)
			return payload
		},
	})

	await Promise.all([
		wrapped(createModel("gpt-5.6-sol"), { messages: [] }, {
			sessionId: "session-alpha",
			onResponse: async (response: any) => {
				responseCallbacks.set("session-alpha", response.headers["x-taas-autorouter-model"])
			},
		}),
		wrapped(createModel("gpt-5.6-sol"), { messages: [] }, {
			sessionId: "session-beta",
			onResponse: async (response: any) => {
				responseCallbacks.set("session-beta", response.headers["x-taas-autorouter-model"])
			},
		}),
	])

	assert.equal(results.get("session-alpha").metadata.session_id, "session-alpha")
	assert.equal(results.get("session-beta").metadata.session_id, "session-beta")
	assert.equal(results.get("session-alpha").metadata.openclaw_correlation.session_id, "session-alpha")
	assert.equal(results.get("session-beta").metadata.openclaw_correlation.session_id, "session-beta")
	assert.equal(responseCallbacks.get("session-alpha"), "route-session-alpha")
	assert.equal(responseCallbacks.get("session-beta"), "route-session-beta")
})

import assert from "node:assert/strict"
import fs from "node:fs"
import plugin from "../index.ts"

const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"))
assert.equal(manifest.activation.onStartup, true, "plugin explicitly loads at gateway startup")
assert.deepEqual(manifest.activation.onProviders, ["cloudsigma", "cloudsigma-staging"])

assert.equal(plugin.id, "openclaw-taas-affinity")
assert.equal(typeof plugin.register, "function")

let provider
plugin.register({
	registerProvider(candidate) {
		provider = candidate
	},
})

assert.ok(provider, "provider should be registered")
assert.equal(provider.id, "taas-affinity-hook")
assert.deepEqual(provider.hookAliases, ["cloudsigma", "cloudsigma-staging"])
assert.equal(typeof provider.wrapStreamFn, "function")
assert.equal(typeof provider.resolveTransportTurnState, "function")

let capturedPayload
const streamFn = async (model, context, options = {}) => {
	capturedPayload = await options.onPayload(
		{ messages: [], metadata: { existing: "keep" } },
		model
	)
	return capturedPayload
}

const wrapped = provider.wrapStreamFn({
	streamFn,
	workspaceDir: "/tmp/openclaw-token-cache-optimizer-smoke",
	provider: "cloudsigma",
	modelId: "cloudsigma/test-model",
	model: { id: "cloudsigma/test-model" },
})

assert.equal(typeof wrapped, "function")
await wrapped("model", { messages: [] }, {})

assert.equal(capturedPayload.metadata.existing, "keep")
assert.match(capturedPayload.metadata.session_id, /^oc:[a-f0-9]{16}$/)
assert.equal(capturedPayload.metadata.sticky_key, capturedPayload.metadata.session_id)
assert.equal(
	capturedPayload.metadata.requester_runtime.source,
	"openclaw-taas-affinity"
)
assert.equal(
	capturedPayload.metadata.requester_runtime.session_key,
	capturedPayload.metadata.session_id
)
assert.equal(
	capturedPayload.metadata.requester_runtime.provider,
	"cloudsigma"
)
assert.equal(
	capturedPayload.metadata.requester_runtime.model_id,
	"cloudsigma/test-model"
)
assert.equal(
	capturedPayload.metadata.requester_runtime.redaction_policy,
	"no_secrets;no_raw_local_paths;no_env_values;no_git_remotes;no_status_or_diffs;no_extra_params"
)
assert.equal(
	capturedPayload.metadata.requester_runtime.tool_execution,
	"direction_2_gateway"
)
assert.equal("available_bridges" in capturedPayload.metadata.requester_runtime, false)

const transportState = provider.resolveTransportTurnState({
	provider: "cloudsigma",
	modelId: "cloudsigma/test-model",
	turnId: "turn-smoke",
	attempt: 1,
	transport: "stream",
})

assert.match(transportState.headers["X-Session-Id"], /^oc:[a-f0-9]{16}$/)

console.log("smoke ok")

// === autorouter capture (R7.1/R7.2 from Studio PRD) ===
// Verify that the wrapper threads an onResponse callback that captures
// X-TaaS-* headers and that taas.autorouter.lastRoute returns them.
let registeredMethod
let registeredHandler
const apiWithGateway = {
	registerProvider(candidate) {
		// keep previous provider too — second registration
	},
	registerGatewayMethod(name, handler) {
		registeredMethod = name
		registeredHandler = handler
	},
}
plugin.register(apiWithGateway)
assert.equal(registeredMethod, "taas.autorouter.lastRoute", "gateway method registered")
assert.equal(typeof registeredHandler, "function", "handler is a function")

// Drive the wrapper through onResponse with synthetic autorouter headers.
const captureStreamFn = async (_model, _context, options = {}) => {
	// pi-ai protocol: call onPayload first (existing behaviour), then onResponse
	// with the simulated HTTP response object, then stream.
	if (options.onPayload) await options.onPayload({ messages: [], metadata: {} }, _model)
	if (options.onResponse) {
		await options.onResponse(
			{
				status: 200,
				headers: {
					"x-taas-autorouted": "true",
					"x-taas-autorouter-model": "cloudsigma/gpt-5",
					"x-taas-autorouter-mode": "best_fit",
					"x-taas-autorouter-algorithm-source": "api_key_default",
					"x-taas-thinking-applied": "medium",
					"x-taas-routed-context-window": "128000",
				},
			},
			_model
		)
	}
}
const captureWrapped = provider.wrapStreamFn({
	streamFn: captureStreamFn,
	workspaceDir: "/tmp/openclaw-token-cache-optimizer-smoke",
	provider: "cloudsigma",
	modelId: "cloudsigma/auto",
	model: { id: "cloudsigma/auto" },
})
await captureWrapped("model", { messages: [] }, {})

// Now invoke the registered gateway handler and assert it returns the capture.
let respondedOk
let respondedPayload
await registeredHandler({
	req: { id: "test" },
	params: { workspaceDir: "/tmp/openclaw-token-cache-optimizer-smoke" },
	client: null,
	isWebchatConnect: () => false,
	respond: (ok, payload) => {
		respondedOk = ok
		respondedPayload = payload
	},
	context: {},
})
assert.equal(respondedOk, true, "handler responded ok")
assert.ok(respondedPayload, "payload present")
assert.match(respondedPayload.sessionId, /^oc:[a-f0-9]{16}$/, "sessionId looks valid")
assert.ok(respondedPayload.capture, "capture present")
assert.equal(respondedPayload.capture.autorouterModel, "cloudsigma/gpt-5")
assert.equal(respondedPayload.capture.autorouterAlgo, "best_fit")
assert.equal(respondedPayload.capture.autorouterAlgoSource, "api_key_default")
assert.equal(respondedPayload.capture.thinkingApplied, "medium")
assert.equal(respondedPayload.capture.routedContextWindow, 128000)

// Non-autorouted response should NOT overwrite (we explicitly drop it)
await captureWrapped("model", { messages: [] }, {})
await registeredHandler({
	req: { id: "t2" },
	params: { workspaceDir: "/tmp/openclaw-token-cache-optimizer-smoke" },
	client: null,
	isWebchatConnect: () => false,
	respond: (_ok, payload) => {
		assert.equal(payload.capture.autorouterModel, "cloudsigma/gpt-5", "still holds last good")
	},
	context: {},
})

console.log("autorouter capture smoke ok")

// === per-agent keying ===
// When the Studio passes { agentId }, the plugin should return the capture
// stored under that agent's key (derived from agentDir/workspaceDir or env).
{
	// First simulate a capture happening for an agent named "new-agent-3"
	const agentWrapped = provider.wrapStreamFn({
		streamFn: async (_m, _c, options = {}) => {
			if (options.onResponse) {
				await options.onResponse(
					{
						status: 200,
						headers: {
							"x-taas-autorouted": "true",
							"x-taas-autorouter-model": "cloudsigma/gpt-5-mini",
							"x-taas-autorouter-mode": "price_performance",
							"x-taas-autorouter-algorithm-source": "user_default",
							"x-taas-thinking-applied": "low",
							"x-taas-routed-context-window": "200000",
						},
					},
					_m
				)
			}
		},
		workspaceDir: "/home/cloudsigma/.openclaw/workspace-new-agent-3",
		agentDir: "/home/cloudsigma/.openclaw/workspace-new-agent-3",
		provider: "cloudsigma",
		modelId: "cloudsigma/auto",
		model: { id: "cloudsigma/auto" },
	})
	await agentWrapped("model", { messages: [] }, {})

	// Now ask via { agentId: "new-agent-3" }
	let agentPayload
	await registeredHandler({
		req: { id: "t-agent" },
		params: { agentId: "new-agent-3" },
		client: null,
		isWebchatConnect: () => false,
		respond: (_ok, payload) => { agentPayload = payload },
		context: {},
	})
	assert.ok(agentPayload?.capture, "agentId lookup returned a capture")
	assert.equal(agentPayload.agentId, "new-agent-3")
	assert.equal(agentPayload.capture.autorouterModel, "cloudsigma/gpt-5-mini")
	assert.equal(agentPayload.capture.autorouterAlgo, "price_performance")
	assert.equal(agentPayload.capture.routedContextWindow, 200000)

	// And a non-matching agentId returns null capture
	let missPayload
	await registeredHandler({
		req: { id: "t-miss" },
		params: { agentId: "no-such-agent" },
		client: null,
		isWebchatConnect: () => false,
		respond: (_ok, payload) => { missPayload = payload },
		context: {},
	})
	assert.equal(missPayload.agentId, "no-such-agent")
	assert.equal(missPayload.capture, null, "miss returns null capture")
}

console.log("per-agent keying smoke ok")

import assert from "node:assert/strict"
import plugin from "../index.ts"

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
	"openclaw-token-cache-optimizer"
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
	"no_secrets;bounded_paths;no_env_values;no_git_remotes;no_status_or_diffs;no_extra_params"
)

const transportState = provider.resolveTransportTurnState({
	provider: "cloudsigma",
	modelId: "cloudsigma/test-model",
	turnId: "turn-smoke",
	attempt: 1,
	transport: "stream",
})

assert.match(transportState.headers["X-Session-Id"], /^oc:[a-f0-9]{16}$/)

console.log("smoke ok")

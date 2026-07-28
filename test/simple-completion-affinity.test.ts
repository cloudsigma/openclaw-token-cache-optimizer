import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../index.ts"

test("simple completion hook is registered and shares affinity injection", async () => {
  let registered: any
  ;(plugin as any).register({ registerProvider: (cfg: any) => { registered = cfg }, registerGatewayMethod: () => {} })
  assert.equal(registered.wrapSimpleCompletionStreamFn, registered.wrapStreamFn)
  let innerOptions: any
  const inner = async function* (_m: any, _c: any, options: any) { innerOptions = options; yield { type: "start" } }
  const wrapped = registered.wrapSimpleCompletionStreamFn({
    provider: "cloudsigma", modelId: "gpt-5.6-sol", agentId: "main",
    workspaceDir: "/home/cloudsigma/.openclaw/workspace", streamFn: inner,
  })
  const gen = wrapped("gpt-5.6-sol", {}, { onPayload: async (p: any) => p })
  await gen.next()
  const patched = await innerOptions.onPayload({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }, "gpt-5.6-sol")
  assert.ok(patched.metadata?.session_id?.startsWith("oc:"))
  assert.equal(patched.metadata?.sticky_key, patched.metadata?.session_id)
  assert.equal(patched.metadata?.openclaw_correlation?.agent_id, "main")
})

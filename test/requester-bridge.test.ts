import assert from "node:assert/strict"
import { createServer } from "node:http"
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

function captureWrapper(plugin: any) {
	let hook: any
	plugin.register({ registerProvider(provider: any) { hook = provider } })
	return hook.wrapStreamFn
}

async function runPayload(wrapperFactory: any, payload: any, ctxExtra: Record<string, unknown> = {}) {
	let captured: any
	const streamFn = (_model: any, _context: any, options: any) => options.onPayload(payload, _model).then((result: any) => {
		captured = result
		return result
	})
	const wrapper = wrapperFactory({
		provider: "cloudsigma",
		modelId: "claude-code",
		workspaceDir: process.cwd(),
		model: { id: "claude-code", baseUrl: ctxExtra.baseUrl },
		streamFn,
		...ctxExtra,
	})
	await wrapper({}, {}, {})
	return captured
}

test("bridge can be explicitly disabled and preserves advisory-only requester runtime", async () => {
	const { plugin, restore } = await loadPlugin({ TAAS_REQUESTER_BRIDGE_PLUGIN_ENABLED: "0" })
	try {
		const payload = await runPayload(captureWrapper(plugin), { messages: [] })
		assert.equal(payload.metadata.requester_runtime.capture_mode, "advisory_only")
		assert.deepEqual(payload.metadata.requester_runtime.available_bridges, [])
		assert.equal("bridge_required" in payload.metadata.requester_runtime, false)
	} finally {
		restore()
	}
})

test("plugin enabled creates lease and injects bridge-capable descriptor", async () => {
	let requestBody: any
	const server = createServer((req, res) => {
		assert.equal(req.method, "POST")
		assert.equal(req.url, "/internal/requester-bridges/leases")
		let body = ""
		req.on("data", (chunk) => { body += chunk })
		req.on("end", () => {
			requestBody = JSON.parse(body)
			res.setHeader("Content-Type", "application/json")
			res.end(JSON.stringify({
				ok: true,
				descriptor: {
					name: "requester-workspace",
					version: "2026-05-23",
					status: "verified",
					bridge_id: "br_test",
					lease_id: "brl_test",
					capabilities: ["requester.tool.invoke"],
					endpoint_ref: "epref_test",
					auth_context_id: "authctx_test",
					expires_at: "2026-05-23T19:00:00Z",
				},
			}))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert(address && typeof address === "object")
	const baseUrl = `http://127.0.0.1:${address.port}`
	const { plugin, restore } = await loadPlugin({})
	try {
		const payload = await runPayload(captureWrapper(plugin), { messages: [] }, { baseUrl })
		assert.equal(requestBody.schema_version, "2026-05-23")
		assert.deepEqual(requestBody.capabilities, ["requester.tool.invoke"])
		assert.equal(payload.metadata.requester_runtime.capture_mode, "bridge_capable")
		assert.equal(payload.metadata.requester_runtime.available_bridges[0].lease_id, "brl_test")
		assert.equal("bridge_required" in payload.metadata.requester_runtime, false)
		assert.equal(JSON.stringify(payload).includes("access_token"), false)
	} finally {
		restore()
		server.close()
	}
})

test("lease failure falls back to advisory-only empty bridges", async () => {
	const server = createServer((_req, res) => {
		res.statusCode = 503
		res.end(JSON.stringify({ ok: false }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert(address && typeof address === "object")
	const { plugin, restore } = await loadPlugin({})
	try {
		const payload = await runPayload(captureWrapper(plugin), { messages: [] }, { baseUrl: `http://127.0.0.1:${address.port}` })
		assert.equal(payload.metadata.requester_runtime.capture_mode, "advisory_only")
		assert.deepEqual(payload.metadata.requester_runtime.available_bridges, [])
	} finally {
		restore()
		server.close()
	}
})


test("plugin enabled polls and executes safe bridge scaffold operation", async () => {
	let pollCount = 0
	let resultBody: any
	const server = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => { body += chunk })
		req.on("end", () => {
			res.setHeader("Content-Type", "application/json")
			if (req.url === "/internal/requester-bridges/leases") {
				res.end(JSON.stringify({
					ok: true,
					descriptor: {
						name: "requester-workspace",
						version: "2026-05-23",
						status: "verified",
						bridge_id: "br_test",
						lease_id: "brl_poll",
						capabilities: ["requester.tool.invoke"],
						endpoint_ref: "epref_test",
						auth_context_id: "authctx_test",
						expires_at: "2026-05-23T19:00:00Z",
					},
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/poll") {
				pollCount += 1
				res.end(JSON.stringify({
					ok: true,
					operations: pollCount === 1 ? [{
						operation_id: "bro_test",
						audit_id: "bra_test",
						lease_id: "brl_poll",
						bridge_id: "br_test",
						operation: "requester.tool.invoke",
						arguments: { tool: "bridge.ping", arguments: { message: "hi" } },
					}] : [],
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/results") {
				resultBody = JSON.parse(body)
				res.end(JSON.stringify({ ok: true }))
				return
			}
			res.statusCode = 404
			res.end(JSON.stringify({ ok: false }))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert(address && typeof address === "object")
	const { plugin, restore } = await loadPlugin({
		TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS: "50",
	})
	try {
		await runPayload(captureWrapper(plugin), { messages: [] }, { baseUrl: `http://127.0.0.1:${address.port}` })
		await new Promise((resolve) => setTimeout(resolve, 150))
		assert.equal(resultBody.operation_id, "bro_test")
		assert.equal(resultBody.ok, true)
		assert.equal(resultBody.result.pong, true)
		assert.equal(resultBody.result.scaffold, true)
		assert.equal(JSON.stringify(resultBody).includes("bridge_required"), false)
	} finally {
		restore()
		server.close()
	}
})

test("plugin handles legacy openclaw.tool.invoke operation name in poll", async () => {
	let pollCount = 0
	let resultBody: any
	const server = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => { body += chunk })
		req.on("end", () => {
			res.setHeader("Content-Type", "application/json")
			if (req.url === "/internal/requester-bridges/leases") {
				res.end(JSON.stringify({
					ok: true,
					descriptor: {
						name: "requester-workspace",
						version: "2026-05-23",
						status: "verified",
						bridge_id: "br_test",
						lease_id: "brl_legacy",
						capabilities: ["requester.tool.invoke"],
						endpoint_ref: "epref_test",
						auth_context_id: "authctx_test",
						expires_at: "2026-05-23T19:00:00Z",
					},
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/poll") {
				pollCount += 1
				res.end(JSON.stringify({
					ok: true,
					operations: pollCount === 1 ? [{
						operation_id: "bro_legacy",
						audit_id: "bra_legacy",
						lease_id: "brl_legacy",
						bridge_id: "br_test",
						operation: "openclaw.tool.invoke",
						arguments: { tool: "bridge.echo", arguments: { msg: "legacy compat" } },
					}] : [],
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/results") {
				resultBody = JSON.parse(body)
				res.end(JSON.stringify({ ok: true }))
				return
			}
			res.statusCode = 404
			res.end(JSON.stringify({ ok: false }))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert(address && typeof address === "object")
	const { plugin, restore } = await loadPlugin({
		TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS: "50",
	})
	try {
		await runPayload(captureWrapper(plugin), { messages: [] }, { baseUrl: `http://127.0.0.1:${address.port}` })
		await new Promise((resolve) => setTimeout(resolve, 150))
		assert.equal(resultBody.operation_id, "bro_legacy")
		assert.equal(resultBody.ok, true)
		assert.equal(resultBody.result.echo.msg, "legacy compat")
		assert.equal(resultBody.result.scaffold, true)
	} finally {
		restore()
		server.close()
	}
})

test("plugin executes non-scaffold requester tools through requester-local gateway", async () => {
	let pollCount = 0
	let resultBody: any
	let gatewayBody: any
	const gateway = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => { body += chunk })
		req.on("end", () => {
			gatewayBody = JSON.parse(body)
			assert.equal(req.url, "/tools/invoke")
			assert.equal(req.headers.authorization, "Bearer requester-token")
			res.setHeader("Content-Type", "application/json")
			res.end(JSON.stringify({ ok: true, result: { rows: [{ title: "PRD" }] } }))
		})
	})
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve))
	const gatewayAddress = gateway.address()
	assert(gatewayAddress && typeof gatewayAddress === "object")

	const taas = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => { body += chunk })
		req.on("end", () => {
			res.setHeader("Content-Type", "application/json")
			if (req.url === "/internal/requester-bridges/leases") {
				res.end(JSON.stringify({
					ok: true,
					descriptor: {
						name: "requester-workspace",
						version: "2026-05-23",
						status: "verified",
						bridge_id: "br_test",
						lease_id: "brl_tool",
						capabilities: ["requester.tool.invoke"],
						endpoint_ref: "epref_test",
						auth_context_id: "authctx_test",
						expires_at: "2026-05-23T19:00:00Z",
					},
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/poll") {
				pollCount += 1
				res.end(JSON.stringify({
					ok: true,
					operations: pollCount === 1 ? [{
						operation_id: "bro_tool",
						audit_id: "bra_tool",
						lease_id: "brl_tool",
						bridge_id: "br_test",
						operation: "requester.tool.invoke",
						arguments: { tool: "prd_list", arguments: { query: "requester bridge" } },
					}] : [],
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/results") {
				resultBody = JSON.parse(body)
				res.end(JSON.stringify({ ok: true }))
				return
			}
			res.statusCode = 404
			res.end(JSON.stringify({ ok: false }))
		})
	})
	await new Promise<void>((resolve) => taas.listen(0, "127.0.0.1", resolve))
	const taasAddress = taas.address()
	assert(taasAddress && typeof taasAddress === "object")
	const { plugin, restore } = await loadPlugin({
		TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS: "50",
		TAAS_REQUESTER_LOCAL_GATEWAY_URL: `http://127.0.0.1:${gatewayAddress.port}`,
		TAAS_REQUESTER_LOCAL_GATEWAY_TOKEN: "requester-token",
	})
	try {
		await runPayload(captureWrapper(plugin), { messages: [] }, { baseUrl: `http://127.0.0.1:${taasAddress.port}` })
		await new Promise((resolve) => setTimeout(resolve, 150))
		assert.deepEqual(gatewayBody, { tool: "prd_list", args: { query: "requester bridge" } })
		assert.equal(resultBody.operation_id, "bro_tool")
		assert.equal(resultBody.ok, true)
		assert.deepEqual(resultBody.result, { rows: [{ title: "PRD" }] })
	} finally {
		restore()
		taas.close()
		gateway.close()
	}
})

test("plugin includes claim_id in result submission when poll returns one", async () => {
	let pollCount = 0
	let resultBody: any
	const server = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => { body += chunk })
		req.on("end", () => {
			res.setHeader("Content-Type", "application/json")
			if (req.url === "/internal/requester-bridges/leases") {
				res.end(JSON.stringify({
					ok: true,
					descriptor: {
						name: "requester-workspace",
						version: "2026-05-23",
						status: "verified",
						bridge_id: "br_test",
						lease_id: "brl_claim",
						capabilities: ["requester.tool.invoke"],
						endpoint_ref: "epref_test",
						auth_context_id: "authctx_test",
						expires_at: "2026-05-23T19:00:00Z",
					},
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/poll") {
				pollCount += 1
				res.end(JSON.stringify({
					ok: true,
					operations: pollCount === 1 ? [{
						operation_id: "bro_claim",
						audit_id: "bra_claim",
						lease_id: "brl_claim",
						bridge_id: "br_test",
						operation: "requester.tool.invoke",
						arguments: { tool: "bridge.ping" },
						claim_id: "brc_abc123claim",
						claim_expires_at: "2026-05-23T20:00:00Z",
						delivery_attempt: 1,
					}] : [],
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/results") {
				resultBody = JSON.parse(body)
				res.end(JSON.stringify({ ok: true }))
				return
			}
			res.statusCode = 404
			res.end(JSON.stringify({ ok: false }))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert(address && typeof address === "object")
	const { plugin, restore } = await loadPlugin({
		TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS: "50",
	})
	try {
		await runPayload(captureWrapper(plugin), { messages: [] }, { baseUrl: `http://127.0.0.1:${address.port}` })
		await new Promise((resolve) => setTimeout(resolve, 150))
		assert.equal(resultBody.operation_id, "bro_claim")
		assert.equal(resultBody.claim_id, "brc_abc123claim")
		assert.equal(resultBody.ok, true)
	} finally {
		restore()
		server.close()
	}
})

test("plugin stops polling stale leases on lease_expired_or_unknown", async () => {
	let pollCount = 0
	const server = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => { body += chunk })
		req.on("end", () => {
			void body
			res.setHeader("Content-Type", "application/json")
			if (req.url === "/internal/requester-bridges/leases") {
				res.end(JSON.stringify({
					ok: true,
					descriptor: {
						name: "requester-workspace",
						version: "2026-05-23",
						status: "verified",
						bridge_id: "br_test",
						lease_id: "brl_stale",
						capabilities: ["requester.tool.invoke"],
						endpoint_ref: "epref_test",
						auth_context_id: "authctx_test",
						expires_at: "2026-05-23T19:00:00Z",
					},
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/poll") {
				pollCount += 1
				res.statusCode = 404
				res.end(JSON.stringify({ ok: false, error: { code: "lease_expired_or_unknown" } }))
				return
			}
			res.statusCode = 404
			res.end(JSON.stringify({ ok: false }))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert(address && typeof address === "object")
	const { plugin, restore } = await loadPlugin({
		TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS: "50",
	})
	try {
		await runPayload(captureWrapper(plugin), { messages: [] }, { baseUrl: `http://127.0.0.1:${address.port}` })
		await new Promise((resolve) => setTimeout(resolve, 220))
		assert.equal(pollCount, 1)
	} finally {
		restore()
		server.close()
	}
})

test("plugin sends wait_ms in poll request for long-polling", async () => {
	let pollBody: any
	const server = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => { body += chunk })
		req.on("end", () => {
			res.setHeader("Content-Type", "application/json")
			if (req.url === "/internal/requester-bridges/leases") {
				res.end(JSON.stringify({
					ok: true,
					descriptor: {
						name: "requester-workspace",
						version: "2026-05-23",
						status: "verified",
						bridge_id: "br_test",
						lease_id: "brl_wait",
						capabilities: ["requester.tool.invoke"],
						endpoint_ref: "epref_test",
						auth_context_id: "authctx_test",
						expires_at: "2026-05-23T19:00:00Z",
					},
				}))
				return
			}
			if (req.url === "/internal/requester-bridges/poll") {
				pollBody = JSON.parse(body)
				res.end(JSON.stringify({ ok: true, operations: [] }))
				return
			}
			res.statusCode = 404
			res.end(JSON.stringify({ ok: false }))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert(address && typeof address === "object")
	const { plugin, restore } = await loadPlugin({
		TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS: "50",
	})
	try {
		await runPayload(captureWrapper(plugin), { messages: [] }, { baseUrl: `http://127.0.0.1:${address.port}` })
		await new Promise((resolve) => setTimeout(resolve, 150))
		assert.equal(pollBody.wait_ms, 25000)
		assert.equal(pollBody.max_operations, 10)
	} finally {
		restore()
		server.close()
	}
})

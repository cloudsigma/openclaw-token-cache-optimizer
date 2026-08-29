import assert from "node:assert/strict"
import { describe, it } from "node:test"
import plugin from "../index.ts"

const { detectFirstClassCloudsigmaOwner, warnOnFirstClassCloudsigmaOwner } = plugin.__test__

describe("legacy/first-class provider coexistence diagnostic", () => {
	it("detects an enabled literal cloudsigma plugin owner", () => {
		const warning = detectFirstClassCloudsigmaOwner({
			plugins: { entries: { cloudsigma: { enabled: true } } },
		})

		assert.match(warning ?? "", /LEGACY TOPOLOGY CONFLICT/)
		assert.match(warning ?? "", /literal `cloudsigma` provider owner/)
		assert.match(warning ?? "", /outbound affinity hooks will not execute/)
	})

	it("treats a configured owner without enabled=false as enabled", () => {
		assert.ok(detectFirstClassCloudsigmaOwner({
			plugins: { entries: { cloudsigma: { config: {} } } },
		}))
	})

	it("does not flag legacy optimizer-only or explicitly disabled owner topology", () => {
		assert.equal(detectFirstClassCloudsigmaOwner({
			models: { providers: { cloudsigma: { baseUrl: "https://taas.cloudsigma.com/v1" } } },
			plugins: { entries: { "openclaw-taas-affinity": { enabled: true } } },
		}), null)
		assert.equal(detectFirstClassCloudsigmaOwner({
			plugins: { entries: { cloudsigma: { enabled: false } } },
		}), null)
	})

	it("logs one loud warning through the supported plugin logger", () => {
		const warnings: string[] = []
		const found = warnOnFirstClassCloudsigmaOwner({
			config: { plugins: { entries: { cloudsigma: { enabled: true } } } },
			logger: { warn: (message: string) => warnings.push(message) },
		} as never)

		assert.equal(found, true)
		assert.equal(warnings.length, 1)
		assert.match(warnings[0], /@cloudsigma\/openclaw-taas-provider as the sole CloudSigma plugin/)
	})
})

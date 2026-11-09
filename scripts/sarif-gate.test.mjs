import { describe, expect, it } from "vitest";
import { assertCleanSarif, parseSarif, sarifFindings } from "./sarif-gate.mjs";

const cleanSarif = { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } }, results: [] }] };
const finding = {
	ruleId: "js/example",
	message: { text: "Example finding" },
	locations: [{ physicalLocation: { artifactLocation: { uri: "packages/demo/index.ts" }, region: { startLine: 4 } } }],
};

describe("SARIF gate", () => {
	it("accepts an empty result set", () => {
		expect(() => assertCleanSarif(cleanSarif)).not.toThrow();
		expect(sarifFindings(cleanSarif)).toEqual([]);
	});

	it("rejects configured findings with location details", () => {
		expect(() => assertCleanSarif({ ...cleanSarif, runs: [{ results: [finding] }] })).toThrow(
			"js/example at packages/demo/index.ts:4: Example finding",
		);
	});

	it("rejects malformed SARIF", () => {
		expect(() => parseSarif("not json")).toThrow("cannot parse SARIF");
		expect(() => parseSarif(JSON.stringify({}))).toThrow("runs array");
	});
});

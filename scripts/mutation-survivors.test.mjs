import { describe, expect, it } from "vitest";
import { formatDetails, formatSummary, gapRows } from "./mutation-survivors.mjs";

const report = {
	files: {
		"packages/mx-pi-demo/src/secure.ts": {
			mutants: [
				{ status: "Killed", location: { start: { line: 3 } }, mutatorName: "BooleanLiteral", replacement: "false" },
				{
					status: "Survived",
					location: { start: { line: 8 } },
					mutatorName: "EqualityOperator",
					replacement: "==",
				},
			],
		},
		"packages/mx-pi-other/index.ts": {
			mutants: [
				{ status: "NoCoverage", location: { start: { line: 2 } }, mutatorName: "StringLiteral", replacement: "x" },
			],
		},
	},
};

describe("mutation survivor reporting", () => {
	it("summarizes gaps without a package-specific path", () => {
		const summary = formatSummary(report);
		expect(summary).toContain("packages/mx-pi-demo/src/secure.ts");
		expect(summary).toContain("packages/mx-pi-other/index.ts");
		expect(summary).not.toContain("mx-pi-agents");
	});

	it("filters details by any file substring", () => {
		const rows = gapRows(report, "secure");
		expect(rows).toHaveLength(1);
		expect(formatDetails(report, "secure")).toContain("EqualityOperator");
		expect(formatDetails(report, "missing")).toContain("No survivors");
	});
});

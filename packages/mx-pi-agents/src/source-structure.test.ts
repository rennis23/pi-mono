/**
 * Static source-structure assertions for the extension entrypoint.
 *
 * This package is the persona-only extraction: it must never register a tool or
 * parse a `#[…]` pipeline. These assertions are cheap insurance that a future
 * change does not quietly reintroduce delegation through `index.ts`.
 *
 * The behavioural coverage of the same surface lives in `index.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("persona-only structure", () => {
	it("does not register a tool", () => {
		const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
		expect(source).not.toContain("registerTool(");
		expect(source).not.toContain("mx_pi_agent");
	});

	it("does not carry the removed pipeline path", () => {
		const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
		expect(source).not.toContain("parsePipeline");
		expect(source).not.toContain("DELEGATE_TOOL");
		expect(source).not.toContain("runParallel");
		expect(source).not.toContain("AgentToolDetails");
	});
});

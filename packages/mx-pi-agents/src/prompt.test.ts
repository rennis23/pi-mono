import { describe, expect, it } from "vitest";
import { assemblePlanPrompt, assembleSystemPrompt, buildRuntimeHeader, MAX_SYSTEM_PROMPT_BYTES } from "./prompt.js";

const base = { agentName: "reviewer", tools: ["read", "grep"], noTools: false };

describe("buildRuntimeHeader", () => {
	it("names the agent and its tools", () => {
		const header = buildRuntimeHeader(base);
		expect(header).toContain("Agent: reviewer");
		expect(header).toContain("Available tools: read, grep");
		expect(header).toContain("cannot delegate");
	});

	it("states plainly when there are no tools", () => {
		const header = buildRuntimeHeader({ ...base, tools: [], noTools: true });
		expect(header).toContain("Available tools: none");
	});

	it("contains no filesystem paths", () => {
		const header = buildRuntimeHeader(base);
		expect(header).not.toMatch(/\/Users|\/home|\/tmp|\.pi\//);
	});
});

describe("assembleSystemPrompt", () => {
	it("puts the header before the body", () => {
		const { systemPrompt } = assembleSystemPrompt("You review code.", base);
		const headerIndex = systemPrompt.indexOf("Agent: reviewer");
		const bodyIndex = systemPrompt.indexOf("You review code.");
		expect(headerIndex).toBeGreaterThanOrEqual(0);
		expect(bodyIndex).toBeGreaterThan(headerIndex);
	});

	it("works with an empty body", () => {
		const { systemPrompt, truncated } = assembleSystemPrompt("   ", base);
		expect(systemPrompt).toContain("Agent: reviewer");
		expect(truncated).toBe(false);
	});

	it("strips control characters but keeps newlines", () => {
		const { systemPrompt } = assembleSystemPrompt("line\u0007one\ntwo", base);
		expect(systemPrompt).not.toContain("\u0007");
		expect(systemPrompt).toContain("lineone\ntwo");
	});

	it("caps the prompt and reports truncation", () => {
		const { systemPrompt, truncated, diagnostics } = assembleSystemPrompt(
			"x".repeat(MAX_SYSTEM_PROMPT_BYTES * 2),
			base,
		);
		expect(truncated).toBe(true);
		expect(Buffer.byteLength(systemPrompt, "utf8")).toBeLessThanOrEqual(MAX_SYSTEM_PROMPT_BYTES + 64);
		expect(diagnostics.some((d) => d.message.includes("truncated"))).toBe(true);
	});

	it("never splits a multi-byte character when truncating", () => {
		const { systemPrompt } = assembleSystemPrompt("é".repeat(MAX_SYSTEM_PROMPT_BYTES), base);
		expect(systemPrompt).not.toContain("\uFFFD");
	});

	it("does not include repository content by construction", () => {
		const { systemPrompt } = assembleSystemPrompt("You review code.", base);
		expect(systemPrompt).not.toContain("SKILL");
		expect(systemPrompt).not.toContain("AGENTS.md");
	});
});

describe("assemblePlanPrompt", () => {
	it("derives noTools from an empty tool list", () => {
		const { systemPrompt } = assemblePlanPrompt({ agentName: "explorer", tools: [] }, "Explore.");
		expect(systemPrompt).toContain("Available tools: none");
	});

	it("lists granted tools", () => {
		const { systemPrompt } = assemblePlanPrompt({ agentName: "builder", tools: ["read", "write"] }, "Build.");
		expect(systemPrompt).toContain("Available tools: read, write");
	});
});

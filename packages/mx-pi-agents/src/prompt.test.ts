import { describe, expect, it } from "vitest";
import {
	assemblePlanPrompt,
	assembleSystemPrompt,
	buildRuntimeHeader,
	MAX_SYSTEM_PROMPT_BYTES,
	RUNTIME_HEADER,
} from "./prompt.js";

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

describe("prompt: exact truncation and header pinning", () => {
	it("pins the fixed runtime header text and line structure", () => {
		expect(RUNTIME_HEADER).toBe(
			[
				"You are a subagent invoked by another pi session.",
				"Work only on the task you were given; report findings concisely.",
				"You cannot delegate to further agents.",
			].join("\n"),
		);
		expect(RUNTIME_HEADER.split("\n")).toHaveLength(3);
	});

	it("newline-joins the header, agent line and tools line", () => {
		const header = buildRuntimeHeader(base);
		expect(header).toBe(
			`${RUNTIME_HEADER}\n\nAgent: reviewer\nAvailable tools: read, grep. Use only these; do not assume others exist.`,
		);
	});

	it("trims the definition body", () => {
		const { systemPrompt } = assembleSystemPrompt("  padded  ", base);
		expect(systemPrompt.endsWith("padded")).toBe(true);
		expect(systemPrompt).not.toContain("  padded  ");
	});

	it("returns exactly the header for a whitespace-only body", () => {
		expect(assembleSystemPrompt("   ", base).systemPrompt).toBe(buildRuntimeHeader(base));
	});

	it("keeps exactly the byte cap before the marker for ASCII", () => {
		const body = "x".repeat(MAX_SYSTEM_PROMPT_BYTES * 2);
		const { systemPrompt } = assembleSystemPrompt(body, base);
		const kept = systemPrompt.replace("\n\n[definition body truncated]", "");
		expect(Buffer.byteLength(kept, "utf8")).toBe(MAX_SYSTEM_PROMPT_BYTES);
		expect(kept).toBe(`${buildRuntimeHeader(base)}\n\n${body}`.slice(0, MAX_SYSTEM_PROMPT_BYTES));
	});

	it("never exceeds the byte cap for multi-byte bodies", () => {
		const { systemPrompt } = assembleSystemPrompt("\u20ac".repeat(MAX_SYSTEM_PROMPT_BYTES), base);
		const kept = systemPrompt.replace("\n\n[definition body truncated]", "");
		expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(MAX_SYSTEM_PROMPT_BYTES);
	});

	it("does not truncate a prompt exactly at the byte cap", () => {
		const header = buildRuntimeHeader(base);
		const bodyBytes = MAX_SYSTEM_PROMPT_BYTES - Buffer.byteLength(header, "utf8") - 2;
		const result = assembleSystemPrompt("a".repeat(bodyBytes), base);
		expect(Buffer.byteLength(result.systemPrompt, "utf8")).toBe(MAX_SYSTEM_PROMPT_BYTES);
		expect(result.truncated).toBe(false);
	});
});

describe("prompt: boundary hardening", () => {
	it("buildRuntimeHeader states the tools or none", () => {
		expect(buildRuntimeHeader({ agentName: "a", tools: ["read", "grep"], noTools: false })).toContain(
			"Available tools: read, grep.",
		);
		expect(buildRuntimeHeader({ agentName: "a", tools: [], noTools: true })).toContain("Available tools: none.");
	});

	it("assembleSystemPrompt strips control characters but keeps newlines", () => {
		const { systemPrompt } = assembleSystemPrompt("line1\u0007\nline2", base);
		expect(systemPrompt).not.toContain("\u0007");
		expect(systemPrompt).toContain("line1\nline2");
	});

	it("assembleSystemPrompt uses the header alone for an empty body", () => {
		const { systemPrompt, truncated } = assembleSystemPrompt("   ", base);
		expect(systemPrompt).toContain("Available tools: read, grep.");
		expect(truncated).toBe(false);
	});

	it("assembleSystemPrompt truncates past the byte cap without splitting a character", () => {
		const body = "€".repeat(MAX_SYSTEM_PROMPT_BYTES);
		const result = assembleSystemPrompt(body, base);
		expect(result.truncated).toBe(true);
		expect(result.systemPrompt).toContain("[definition body truncated]");
		expect(result.diagnostics.some((d) => d.message.includes("exceeded"))).toBe(true);
		expect(result.systemPrompt.includes("\uFFFD")).toBe(false);
	});

	it("assemblePlanPrompt derives noTools from the grant length", () => {
		expect(assemblePlanPrompt({ agentName: "a", tools: [] }, "body").systemPrompt).toContain(
			"Available tools: none.",
		);
		expect(assemblePlanPrompt({ agentName: "a", tools: ["read"] }, "body").systemPrompt).toContain(
			"Available tools: read.",
		);
	});
});

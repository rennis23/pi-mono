import { describe, expect, it } from "vitest";
import { makeAgent } from "../test/fixtures.js";
import { type CompletionSource, completionItems, directiveContext, toCompletionSource } from "./complete.js";

function source(overrides: Partial<CompletionSource> = {}): CompletionSource {
	return {
		name: "explorer",
		description: "reads things",
		source: "bundled",
		trusted: true,
		mode: "append",
		...overrides,
	};
}

describe("directiveContext", () => {
	it("matches a bare hash", () => {
		expect(directiveContext("#")).toEqual({ prefix: "#" });
	});

	it("matches a partial single name", () => {
		expect(directiveContext("#bui")).toEqual({ prefix: "#bui" });
	});

	it("allows leading whitespace", () => {
		expect(directiveContext("  #bui")).toEqual({ prefix: "#bui" });
	});

	it("returns undefined once the task has begun", () => {
		expect(directiveContext("#builder do it")).toBeUndefined();
	});

	it("returns undefined outside a directive", () => {
		expect(directiveContext("@file.ts")).toBeUndefined();
		expect(directiveContext("mid #bui")).toBeUndefined();
		expect(directiveContext("plain prompt")).toBeUndefined();
	});

	it("returns undefined for an invalid single-name character", () => {
		expect(directiveContext("#bui!")).toBeUndefined();
	});

	it("returns undefined inside a removed bracket pipeline", () => {
		expect(directiveContext("#[planner")).toBeUndefined();
		expect(directiveContext("#[planner > bui")).toBeUndefined();
	});
});

describe("toCompletionSource", () => {
	it("projects the pinned roster", () => {
		const agent = makeAgent({ name: "explorer", sourceKind: "bundled", systemPrompt: "replace" });
		expect(toCompletionSource([agent])).toEqual([
			{ name: "explorer", description: "explorer description", source: "bundled", trusted: true, mode: "replace" },
		]);
	});
});

describe("completionItems", () => {
	const roster: CompletionSource[] = [
		source({ name: "explorer" }),
		source({ name: "planner" }),
		source({ name: "builder" }),
		source({ name: "local", source: "project", trusted: false }),
	];

	it("values with the hash", () => {
		expect(completionItems(roster, { prefix: "#bui" })[0].value).toBe("#builder");
	});

	it("orders prefix matches before substring matches", () => {
		const items = completionItems(roster, { prefix: "#e" });
		expect(items.map((item) => item.label)).toEqual(["explorer [append]", "planner [append]", "builder [append]"]);
	});

	it("badges each item with its mode and offers the built-in reset row", () => {
		const items = completionItems([source({ name: "review", mode: "replace" })], { prefix: "#" });
		expect(items[0]).toEqual({ value: "#none", label: "pi.dev [base]", description: "reset to plain pi" });
		expect(items.some((item) => item.label === "review [replace]" && item.value === "#review")).toBe(true);
	});

	it("marks gated sources", () => {
		expect(completionItems(roster, { prefix: "#loc" })[0].description).toContain("gated");
	});

	it("returns everything (capped) for an empty prefix", () => {
		const many = Array.from({ length: 30 }, (_, i) => source({ name: `agent${i}` }));
		expect(completionItems(many, { prefix: "#" })).toHaveLength(20);
	});

	it("returns an empty list when nothing matches", () => {
		expect(completionItems(roster, { prefix: "#zzz" })).toEqual([]);
	});

	it("sanitizes a hostile description", () => {
		const items = completionItems([source({ description: "evil\u0007\u001b[31m" })], { prefix: "#exp" });
		expect(items[0].description).not.toMatch(/[\u0000-\u0009\u000B-\u001F]/);
	});
});

describe("complete: boundary hardening", () => {
	it("requires the # to start the line", () => {
		expect(directiveContext("foo #bar")).toBeUndefined();
		expect(directiveContext("  #bar")).toEqual({ prefix: "#bar" });
	});

	it("completionItems filters prefix then substring", () => {
		const src = [source({ name: "abc" }), source({ name: "xab" }), source({ name: "zzz" })];
		expect(completionItems(src, { prefix: "#ab" }).map((item) => item.value)).toEqual(["#abc", "#xab"]);
	});

	it("offers the base row for the none and pi.dev prefixes", () => {
		const src = [source({ name: "nope" })];
		expect(completionItems(src, { prefix: "#none" }).some((item) => item.value === "#none")).toBe(true);
		expect(completionItems(src, { prefix: "#pi" })[0]?.value).toBe("#none");
	});
});

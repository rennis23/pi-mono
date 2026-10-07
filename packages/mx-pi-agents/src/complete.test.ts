import { describe, expect, it } from "vitest";
import { makeAgent } from "../test/fixtures.js";
import { type CompletionSource, completionItems, directiveContext, toCompletionSource } from "./complete.js";

function source(overrides: Partial<CompletionSource> = {}): CompletionSource {
	return {
		name: "explorer",
		description: "reads things",
		source: "bundled",
		trusted: true,
		kind: "append",
		...overrides,
	};
}

describe("directiveContext", () => {
	it("matches a bare hash", () => {
		expect(directiveContext("#")).toEqual({ mode: "single", prefix: "#" });
	});

	it("matches a partial single name", () => {
		expect(directiveContext("#bui")).toEqual({ mode: "single", prefix: "#bui" });
	});

	it("allows leading whitespace", () => {
		expect(directiveContext("  #bui")).toEqual({ mode: "single", prefix: "#bui" });
	});

	it("matches after an opening bracket", () => {
		expect(directiveContext("#[")).toEqual({ mode: "pipeline", prefix: "" });
		expect(directiveContext("#[pla")).toEqual({ mode: "pipeline", prefix: "pla" });
	});

	it("matches after > and , inside a pipeline", () => {
		expect(directiveContext("#[planner > bui")).toEqual({ mode: "pipeline", prefix: "bui" });
		expect(directiveContext("#[planner > builder > ")).toEqual({ mode: "pipeline", prefix: "" });
		expect(directiveContext("#[planner, bui")).toEqual({ mode: "pipeline", prefix: "bui" });
	});

	it("returns undefined once the bracket is closed", () => {
		expect(directiveContext("#[planner > builder] ")).toBeUndefined();
		expect(directiveContext("#[planner] task")).toBeUndefined();
	});

	it("returns undefined once the single task has begun", () => {
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
});

describe("toCompletionSource", () => {
	it("projects the pinned roster", () => {
		const agent = makeAgent({ name: "explorer", sourceKind: "bundled" });
		const projected = toCompletionSource([agent]);
		expect(projected).toEqual([
			{ name: "explorer", description: "explorer description", source: "bundled", trusted: true, kind: "append" },
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

	it("values with the hash in single mode and without it in pipeline mode", () => {
		const single = completionItems(roster, { mode: "single", prefix: "#bui" });
		expect(single[0].value).toBe("#builder");
		const pipeline = completionItems(roster, { mode: "pipeline", prefix: "bui" });
		expect(pipeline[0].value).toBe("builder");
	});

	it("orders prefix matches before substring matches", () => {
		const items = completionItems(roster, { mode: "single", prefix: "#e" });
		expect(items.map((item) => item.label)).toEqual(["explorer [append]", "planner [append]", "builder [append]"]);
	});

	it("badges each item with its kind and offers the built-in reset row", () => {
		const items = completionItems([source({ name: "review", kind: "replace" })], {
			mode: "single",
			prefix: "#",
		});
		expect(items[0]).toEqual({ value: "#none", label: "pi.dev [base]", description: "reset to plain pi" });
		expect(items.some((item) => item.label === "review [replace]" && item.value === "#review")).toBe(true);
	});

	it("does not offer the reset row inside a pipeline", () => {
		const items = completionItems(roster, { mode: "pipeline", prefix: "" });
		expect(items.some((item) => item.value === "none" || item.value === "#none")).toBe(false);
	});

	it("marks gated sources", () => {
		const items = completionItems(roster, { mode: "single", prefix: "#loc" });
		expect(items[0].description).toContain("gated");
	});

	it("returns everything (capped) for an empty prefix", () => {
		const many = Array.from({ length: 30 }, (_, i) => source({ name: `agent${i}` }));
		expect(completionItems(many, { mode: "single", prefix: "#" })).toHaveLength(20);
	});

	it("returns an empty list when nothing matches", () => {
		expect(completionItems(roster, { mode: "single", prefix: "#zzz" })).toEqual([]);
	});

	it("sanitizes a hostile description", () => {
		const items = completionItems([source({ description: "evil\u0007\u001b[31m" })], {
			mode: "single",
			prefix: "#exp",
		});
		expect(items[0].description).not.toMatch(/[\u0000-\u0009\u000B-\u001F]/);
	});
});

describe("complete: boundary hardening", () => {
	it("directiveContext detects single, pipeline and non-directive positions", () => {
		expect(directiveContext("hello")).toBeUndefined();
		expect(directiveContext("x #a")).toBeUndefined();
		expect(directiveContext("  #exp")).toEqual({ mode: "single", prefix: "#exp" });
		expect(directiveContext("#[a > b")).toEqual({ mode: "pipeline", prefix: "b" });
		expect(directiveContext("#[a]")).toBeUndefined();
		expect(directiveContext("#a task")).toBeUndefined();
		expect(directiveContext("#a")).toEqual({ mode: "single", prefix: "#a" });
	});

	it("completionItems filters prefix then substring", () => {
		const src = [source({ name: "abc" }), source({ name: "xab" }), source({ name: "zzz" })];
		const items = completionItems(src, { mode: "single", prefix: "#ab" });
		expect(items.map((item) => item.value)).toEqual(["#abc", "#xab"]);
	});

	it("completionItems offers the base row in single mode only", () => {
		const src = [source({ name: "nope" })];
		expect(completionItems(src, { mode: "single", prefix: "#" }).some((item) => item.value === "#none")).toBe(true);
		expect(completionItems(src, { mode: "single", prefix: "#pi" }).some((item) => item.value === "#none")).toBe(true);
		expect(completionItems(src, { mode: "pipeline", prefix: "" }).some((item) => item.value === "none")).toBe(false);
	});

	it("completionItems caps at 20 and marks gated sources", () => {
		const many = Array.from({ length: 25 }, (_, index) => source({ name: `a${index}` }));
		expect(completionItems(many, { mode: "single", prefix: "#a" })).toHaveLength(20);
		const items = completionItems([source({ name: "a", trusted: false })], { mode: "single", prefix: "#a" });
		expect(items[0].description).toContain("gated");
	});

	it("toCompletionSource maps the pinned fields", () => {
		const agent = makeAgent({ name: "mapped", systemPrompt: "replace", mainAgentOnly: true });
		const [entry] = toCompletionSource([agent]);
		expect(entry).toMatchObject({ name: "mapped", kind: "replace", trusted: true, source: "global" });
	});
});

describe("complete: survivor kills", () => {
	it("requires the # to start the line", () => {
		expect(directiveContext("foo #bar")).toBeUndefined();
		expect(directiveContext("  #bar")).toEqual({ mode: "single", prefix: "#bar" });
	});

	it("falls back to an empty pipeline prefix", () => {
		expect(directiveContext("#[a.")).toEqual({ mode: "pipeline", prefix: "" });
	});

	it("marks gated agents in the description", () => {
		const rows = completionItems([source({ name: "gated", trusted: false })], { mode: "single", prefix: "#" });
		const gated = rows.find((r) => r.label.startsWith("gated"));
		expect(gated?.description).toContain("gated");
	});

	it("offers pi.dev in single mode and never in a pipeline", () => {
		const items = [source()];
		expect(completionItems(items, { mode: "single", prefix: "#" })[0]?.value).toBe("#none");
		expect(completionItems(items, { mode: "pipeline", prefix: "" }).some((r) => r.value === "none")).toBe(false);
	});

	it("offers pi.dev for the none and pi.dev prefixes", () => {
		const items = [source()];
		expect(completionItems(items, { mode: "single", prefix: "#n" })[0]?.value).toBe("#none");
		expect(completionItems(items, { mode: "single", prefix: "#pi" })[0]?.value).toBe("#none");
	});

	it("ranks prefix matches before substring matches", () => {
		const items = [source({ name: "beta", kind: "append" }), source({ name: "alpha", kind: "append" })];
		const rows = completionItems(items, { mode: "pipeline", prefix: "a" });
		expect(rows.map((r) => r.label)).toEqual(["alpha [append]", "beta [append]"]);
	});

	it("caps the roster at 20 items", () => {
		const items = Array.from({ length: 30 }, (_, i) => source({ name: `agent-${i}` }));
		expect(completionItems(items, { mode: "pipeline", prefix: "" })).toHaveLength(20);
	});
});

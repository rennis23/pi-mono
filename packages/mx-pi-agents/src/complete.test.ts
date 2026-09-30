import { describe, expect, it } from "vitest";
import { makeAgent } from "../test/fixtures.js";
import { type CompletionSource, completionItems, directiveContext, toCompletionSource } from "./complete.js";

function source(overrides: Partial<CompletionSource> = {}): CompletionSource {
	return { name: "explorer", description: "reads things", source: "bundled", trusted: true, ...overrides };
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
		const agent = makeAgent({ name: "explorer", kind: "bundled" });
		const projected = toCompletionSource([agent]);
		expect(projected).toEqual([
			{ name: "explorer", description: "explorer description", source: "bundled", trusted: true },
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
		expect(items.map((item) => item.label)).toEqual(["explorer", "planner", "builder"]);
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

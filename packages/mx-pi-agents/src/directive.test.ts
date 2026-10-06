import { describe, expect, it } from "vitest";
import { parseDirective } from "./directive.js";

function ok(text: string) {
	const outcome = parseDirective(text);
	if (outcome === undefined) throw new Error(`expected a directive, got undefined for ${JSON.stringify(text)}`);
	if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.message}`);
	return outcome.directive;
}

function error(text: string): string {
	const outcome = parseDirective(text);
	if (outcome === undefined) throw new Error(`expected a directive error, got undefined for ${JSON.stringify(text)}`);
	if (outcome.ok) throw new Error(`expected an error, got ok for ${JSON.stringify(text)}`);
	return outcome.message;
}

describe("parseDirective: non-directives", () => {
	it("returns undefined when there is no leading #", () => {
		expect(parseDirective("explain this")).toBeUndefined();
		expect(parseDirective("@file.ts")).toBeUndefined();
		expect(parseDirective("what #hash means")).toBeUndefined();
		expect(parseDirective("")).toBeUndefined();
	});
});

describe("parseDirective: single agent", () => {
	it("parses the worked example", () => {
		const directive = ok("#socrates Where is the config loaded?");
		expect(directive.name).toBe("socrates");
		expect(directive.task).toBe("Where is the config loaded?");
	});

	it("allows leading whitespace", () => {
		const directive = ok("   \t#socrates hi");
		expect(directive.name).toBe("socrates");
		expect(directive.task).toBe("hi");
	});

	it("keeps the task opaque, including delimiters", () => {
		const directive = ok("#socrates explain #1, then a > b and [c]");
		expect(directive.task).toBe("explain #1, then a > b and [c]");
	});

	it("accepts the 64-character name boundary", () => {
		const name = `a${"b".repeat(63)}`;
		expect(ok(`#${name} task`).name).toBe(name);
	});

	it("rejects a name longer than the boundary", () => {
		expect(error(`#${"a".repeat(65)} task`)).toContain("invalid agent name");
	});

	it("rejects an empty agent", () => {
		expect(error("#")).toContain("no agent named");
		expect(error("# ")).toContain("no agent named");
	});

	it("parses a bare single name as a task-less directive", () => {
		expect(ok("#socrates").task).toBeUndefined();
		expect(ok("#socrates   ").task).toBeUndefined();
	});

	it("rejects a malformed name", () => {
		expect(error("#-x task")).toContain("invalid agent name");
		expect(error("#_bad")).toContain("invalid agent name");
	});

	it("trims the task text after whitespace", () => {
		expect(ok("#a\t  hi there  ").task).toBe("hi there");
	});

	it("requires whitespace between name and task", () => {
		expect(ok("#a").task).toBeUndefined();
	});
});

describe("parseDirective: removed pipelines", () => {
	it("reports a bracketed pipeline as removed", () => {
		expect(error("#[explorer] find it")).toContain("bracketed pipelines were removed");
		expect(error("#[a > b] task")).toContain("bracketed pipelines were removed");
	});

	it("reports a bare-name pipeline delimiter as removed", () => {
		expect(error("#builder > explorer do it")).toContain("pipelines were removed");
		expect(error("#builder,explorer do it")).toContain("pipelines were removed");
	});
});

describe("directive: hardening", () => {
	it("includes the usage in an empty-name error", () => {
		expect(error("#   ")).toContain('Usage: "#name [prompt]"');
	});

	it("accepts a 64-char name and rejects a 65th name character", () => {
		expect(ok(`#${"a".repeat(64)}`).name).toHaveLength(64);
		expect(error(`#${"a".repeat(65)}`)).toContain("invalid agent name");
	});
});

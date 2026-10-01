import { describe, expect, it } from "vitest";
import { MAX_PIPELINE_STAGES, parseDirective } from "./directive.js";

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
		const directive = ok("#explorer Where is the config loaded?");
		expect(directive.stages).toEqual([{ agents: ["explorer"] }]);
		expect(directive.task).toBe("Where is the config loaded?");
	});

	it("allows leading whitespace", () => {
		const directive = ok("   \t#explorer hi");
		expect(directive.stages).toEqual([{ agents: ["explorer"] }]);
		expect(directive.task).toBe("hi");
	});

	it("keeps the task opaque, including delimiters", () => {
		const directive = ok("#explorer explain #1, then a > b and [c]");
		expect(directive.task).toBe("explain #1, then a > b and [c]");
	});

	it("accepts the 64-character name boundary", () => {
		const name = `a${"b".repeat(63)}`;
		const directive = ok(`#${name} task`);
		expect(directive.stages).toEqual([{ agents: [name] }]);
	});

	it("rejects a name longer than the boundary", () => {
		expect(error(`#${"a".repeat(65)} task`)).toContain("invalid agent name");
	});

	it("rejects an empty agent", () => {
		expect(error("#")).toContain("no agent named");
		expect(error("# ")).toContain("no agent named");
	});

	it("parses a bare single name as a task-less directive", () => {
		const directive = ok("#explorer");
		expect(directive.stages).toEqual([{ agents: ["explorer"] }]);
		expect(directive.task).toBeUndefined();
		const spaced = ok("#explorer   ");
		expect(spaced.task).toBeUndefined();
	});

	it("rejects a malformed name", () => {
		expect(error("#-x task")).toContain("invalid agent name");
	});
});

describe("parseDirective: pipelines", () => {
	it("parses the worked example", () => {
		const directive = ok("#[planner > builder > review1, review2] Add a login page");
		expect(directive.stages).toEqual([
			{ agents: ["planner"] },
			{ agents: ["builder"] },
			{ agents: ["review1", "review2"] },
		]);
		expect(directive.task).toBe("Add a login page");
	});

	it("parses a single-agent bracket", () => {
		const directive = ok("#[explorer] find it");
		expect(directive.stages).toEqual([{ agents: ["explorer"] }]);
		expect(directive.task).toBe("find it");
	});

	it("tolerates whitespace around delimiters", () => {
		const directive = ok("#[ a ,b>c] task");
		expect(directive.stages).toEqual([{ agents: ["a", "b"] }, { agents: ["c"] }]);
	});

	it("rejects an empty pipeline", () => {
		expect(error("#[] task")).toContain("empty pipeline");
		expect(error("#[   ] task")).toContain("empty pipeline");
	});

	it("rejects an unclosed pipeline", () => {
		expect(error("#[a > b task")).toContain("unclosed pipeline");
	});

	it("rejects empty stages and dangling delimiters", () => {
		expect(error("#[a >] task")).toContain("empty stage");
		expect(error("#[> a] task")).toContain("empty stage");
		expect(error("#[a,,b] task")).toContain("empty stage");
	});

	it("rejects an invalid name inside a stage", () => {
		expect(error("#[a b] task")).toContain("invalid agent name");
	});

	it("rejects a missing task", () => {
		expect(error("#[a > b]")).toContain("missing a prompt");
		expect(error("#[a > b]   ")).toContain("missing a prompt");
	});

	it("accepts the stage-count boundary and rejects one past it", () => {
		const stages = Array.from({ length: MAX_PIPELINE_STAGES }, (_, i) => `a${i}`);
		const directive = ok(`#[${stages.join(" > ")}] task`);
		expect(directive.stages).toHaveLength(MAX_PIPELINE_STAGES);
		expect(error(`#[${[...stages, "toomany"].join(" > ")}] task`)).toContain("too many stages");
	});
});

describe("parseDirective: delimiter hints", () => {
	it("points at brackets for an inline pipeline", () => {
		expect(error("#builder > explorer do it")).toContain("require brackets");
		expect(error("#builder,explorer do it")).toContain("require brackets");
	});
});

describe("directive: boundary hardening", () => {
	it("parses a bare name with and without a task", () => {
		expect(ok("#agent").task).toBeUndefined();
		expect(ok("#agent do it").task).toBe("do it");
		expect(ok("#agent\ttab task").task).toBe("tab task");
	});

	it("rejects an overlong or invalid name", () => {
		expect(error(`#${"a".repeat(65)}`)).toContain("invalid agent name");
		expect(error("#-bad")).toContain("invalid agent name");
	});

	it("rejects a bare name followed by a pipeline delimiter", () => {
		expect(error("#a > b")).toContain("require brackets");
		expect(error("#a, b")).toContain("require brackets");
	});

	it("parses a bracketed pipeline and trims the task", () => {
		const directive = ok("#[a > b, c]   do it  ");
		expect(directive.pipeline).toBe(true);
		expect(directive.stages).toEqual([{ agents: ["a"] }, { agents: ["b", "c"] }]);
		expect(directive.task).toBe("do it");
	});

	it("rejects empty, unclosed and promptless pipelines", () => {
		expect(error("#[] x")).toContain("empty pipeline");
		expect(error("#[a x")).toContain("unclosed pipeline");
		expect(error("#[a]")).toContain("missing a prompt");
	});
});

describe("directive: survivor kills", () => {
	it("includes the usage in an empty-name error", () => {
		expect(error("#   ")).toContain('Usage: "#agent [prompt]"');
	});

	it("rejects a name starting with a non-alphanumeric", () => {
		expect(error("#_bad")).toContain("invalid agent name");
		expect(error("#-bad")).toContain("invalid agent name");
	});

	it("accepts a 64-char name and rejects a 65th name character", () => {
		expect(ok(`#${"a".repeat(64)}`).stages[0].agents[0]).toHaveLength(64);
		expect(error(`#${"a".repeat(65)}`)).toContain("invalid agent name");
	});

	it("trims the task text after a tab", () => {
		expect(ok("#a\t  hi there  ").task).toBe("hi there");
	});

	it("trims the pipeline task after a tab", () => {
		expect(ok("#[a > b]\t  do it  ").task).toBe("do it");
	});

	it("requires whitespace between name and task", () => {
		expect(ok("#a").task).toBeUndefined();
	});
});

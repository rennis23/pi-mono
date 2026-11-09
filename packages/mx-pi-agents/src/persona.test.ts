import { describe, expect, it } from "vitest";
import { makeAgent } from "../test/fixtures.js";
import type { SwitchContext } from "./persona.js";
import {
	applyOverrides,
	dispatchDirective,
	lastSwitchEntry,
	parseSwitchEntry,
	planReset,
	planSwitch,
	RESET_NAME,
	rehydrate,
	runtimeMatches,
	snapshotBaseline,
} from "./persona.js";
import type { SwitchBaseline, SwitchEntryData, ThinkingLevel } from "./types.js";

const context: SwitchContext = {
	availableTools: ["read", "grep", "bash", "edit", "write"],
	isModelAvailable: (model) => model === "anthropic/claude-sonnet-4-5",
};

describe("dispatchDirective", () => {
	it("treats none as reset and refuses a task", () => {
		expect(dispatchDirective({ name: "none", known: false, hasTask: false })).toEqual({ action: "reset" });
		expect(dispatchDirective({ name: "none", known: true, hasTask: true })).toEqual({
			action: "refuse",
			message: '"#none" takes no task.',
		});
	});

	it("refuses an unknown name", () => {
		expect(dispatchDirective({ name: "ghost", known: false, hasTask: true })).toEqual({
			action: "refuse",
			message: 'unknown agent "#ghost".',
		});
	});

	it("switches for a known name, with or without a task", () => {
		expect(dispatchDirective({ name: "p", known: true, hasTask: false })).toEqual({ action: "switch" });
		expect(dispatchDirective({ name: "m", known: true, hasTask: true })).toEqual({ action: "switch" });
	});
});

describe("planSwitch", () => {
	it("builds a replace plan for replace and an append plan for append", () => {
		const replace = planSwitch(makeAgent({ name: "p", systemPrompt: "replace", tools: ["read"] }), context);
		expect(replace.ok).toBe(true);
		if (!replace.ok) return;
		expect(replace.plan.mode).toBe("replace");
		expect(replace.plan.applied.tools).toEqual(["read"]);

		const append = planSwitch(makeAgent({ name: "m", systemPrompt: "append", tools: ["read"] }), context);
		expect(append.ok).toBe(true);
		if (!append.ok) return;
		expect(append.plan.mode).toBe("append");
	});

	it("leaves absent fields untouched", () => {
		const outcome = planSwitch(makeAgent({ name: "p", systemPrompt: "replace" }), context);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.applied).toEqual({});
	});

	it("treats present-and-empty tools as no tools", () => {
		const outcome = planSwitch(makeAgent({ name: "p", systemPrompt: "replace", tools: [] }), context);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.applied.tools).toEqual([]);
	});

	it("refuses the whole switch when a declared tool does not resolve", () => {
		const outcome = planSwitch(makeAgent({ name: "p", tools: ["read", "ghost"] }), context);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal).toContain("do not resolve in the main session");
		expect(outcome.refusal).toContain("ghost");
	});

	it("refuses the whole switch when a declared model is unavailable", () => {
		const outcome = planSwitch(makeAgent({ name: "p", model: "openai/gpt-none", thinking: "high" }), context);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal).toContain("not available");
	});

	it("applies present tools, model and thinking", () => {
		const outcome = planSwitch(
			makeAgent({ name: "p", tools: ["read", "grep"], model: "anthropic/claude-sonnet-4-5", thinking: "high" }),
			context,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.applied).toEqual({
			tools: ["read", "grep"],
			model: "anthropic/claude-sonnet-4-5",
			thinking: "high",
		});
	});
});

describe("snapshotBaseline / applyOverrides / runtimeMatches", () => {
	it("snapshots and overrides only declared fields", () => {
		const baseline = snapshotBaseline({ tools: ["read"], model: "a/b", thinking: "low" });
		expect(baseline).toEqual({ tools: ["read"], model: "a/b", thinking: "low" });
		const merged = applyOverrides(baseline, { tools: ["bash"] });
		expect(merged).toEqual({ tools: ["bash"], model: "a/b", thinking: "low" });
	});

	it("copies the tool list", () => {
		const tools = ["a", "b"];
		const baseline = snapshotBaseline({ tools, model: "m", thinking: "low" });
		tools.push("c");
		expect(baseline.tools).toEqual(["a", "b"]);
	});

	it("prefers applied values, including an empty tool list", () => {
		const baseline = snapshotBaseline({ tools: ["a"], model: "m", thinking: "low" });
		expect(applyOverrides(baseline, {})).toEqual(baseline);
		expect(applyOverrides(baseline, { tools: [], model: "x", thinking: "high" })).toEqual({
			tools: [],
			model: "x",
			thinking: "high",
		});
	});

	it("compares tool sets regardless of order", () => {
		const target: SwitchBaseline = { tools: ["read", "grep"], model: undefined, thinking: undefined };
		expect(runtimeMatches({ tools: ["grep", "read"], model: undefined, thinking: undefined }, target)).toBe(true);
		expect(runtimeMatches({ tools: ["read"], model: undefined, thinking: undefined }, target)).toBe(false);
		expect(
			runtimeMatches(
				{ tools: ["read", "other"], model: undefined, thinking: undefined },
				{ tools: ["read", "grep"], model: undefined, thinking: undefined },
			),
		).toBe(false);
	});

	it("compares model and thinking exactly", () => {
		const target = snapshotBaseline({ tools: [], model: "m", thinking: "low" });
		expect(runtimeMatches({ tools: [], model: "m", thinking: "low" }, target)).toBe(true);
		expect(runtimeMatches({ tools: [], model: "x", thinking: "low" }, target)).toBe(false);
		expect(runtimeMatches({ tools: [], model: "m", thinking: "high" }, target)).toBe(false);
	});
});

describe("planReset", () => {
	it("restores the baseline", () => {
		const plan = planReset({ tools: ["read"], model: "anthropic/claude-sonnet-4-5", thinking: "low" }, context);
		expect(plan.tools).toEqual(["read"]);
		expect(plan.model).toBe("anthropic/claude-sonnet-4-5");
		expect(plan.thinking).toBe("low");
		expect(plan.warnings).toEqual([]);
	});

	it("skips a tool that no longer resolves with a warning", () => {
		const plan = planReset({ tools: ["read", "gone"], model: undefined, thinking: undefined }, context);
		expect(plan.tools).toEqual(["read"]);
		expect(plan.warnings.join("\n")).toContain("gone");
	});

	it("skips a model that is no longer available with a warning", () => {
		const plan = planReset({ tools: [], model: "openai/gpt-none", thinking: undefined }, context);
		expect(plan.model).toBeUndefined();
		expect(plan.warnings.join("\n")).toContain("gpt-none");
	});
});

function entry(overrides: Partial<SwitchEntryData> = {}): SwitchEntryData {
	return {
		name: "p",
		mode: "append",
		baseline: { tools: ["read"], model: undefined, thinking: undefined },
		applied: { tools: ["bash"] },
		switchedAt: 1000,
		...overrides,
	};
}

describe("parseSwitchEntry / lastSwitchEntry", () => {
	it("round-trips a valid entry and rejects malformed data", () => {
		expect(parseSwitchEntry(entry())).toEqual(entry());
		expect(parseSwitchEntry(null)).toBeUndefined();
		expect(parseSwitchEntry({ name: 3 })).toBeUndefined();
		expect(parseSwitchEntry({ name: "p", mode: "persona", switchedAt: 1, baseline: { tools: [] } })).toBeUndefined();
		expect(parseSwitchEntry({ name: "p", mode: "main", switchedAt: 1 })).toBeUndefined();
	});

	it("takes the last switch entry on the branch", () => {
		const branch = [
			{ type: "custom", customType: "mx-pi-agents.switch", data: entry({ name: "a", mode: "append" }) },
			{ type: "message" },
			{ type: "custom", customType: "mx-pi-agents.switch", data: entry({ name: "b", mode: "replace" }) },
		];
		expect(lastSwitchEntry(branch)?.name).toBe("b");
		expect(lastSwitchEntry([{ type: "message" }])).toBeUndefined();
	});

	it("allows a null name with no mode but rejects a null name with a bad mode", () => {
		expect(parseSwitchEntry({ name: null, switchedAt: 1, baseline: { tools: [] } })?.name).toBeNull();
		expect(parseSwitchEntry({ name: null, mode: "sub", switchedAt: 1, baseline: { tools: [] } })).toBeUndefined();
	});

	it("normalizes a null model and rejects malformed shapes", () => {
		expect(
			parseSwitchEntry({ ...entry(), baseline: { tools: ["a"], model: null, thinking: undefined } })?.baseline.model,
		).toBeUndefined();
		expect(parseSwitchEntry([])).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), switchedAt: Number.NaN })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), switchedAt: "x" })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), baseline: {} })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), baseline: { tools: [1] } })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), baseline: { tools: [], model: 5 } })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), applied: 5 })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), applied: { tools: [1] } })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), applied: { model: 5 } })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), applied: { thinking: 5 } })).toBeUndefined();
		expect(parseSwitchEntry({ ...entry(), applied: undefined })?.applied).toBeUndefined();
	});
});

describe("rehydrate", () => {
	it("is inactive without an entry or for a reset entry", () => {
		expect(rehydrate(undefined, { tools: [], model: undefined, thinking: undefined })).toEqual({ active: false });
		expect(
			rehydrate(entry({ name: null, mode: undefined, applied: undefined }), {
				tools: ["read"],
				model: undefined,
				thinking: undefined,
			}),
		).toEqual({ active: false });
	});

	it("re-applies the preset when the runtime is still the baseline", () => {
		const decision = rehydrate(entry(), { tools: ["read"], model: undefined, thinking: undefined });
		expect(decision.active).toBe(true);
		if (!decision.active) return;
		expect(decision.name).toBe("p");
		expect(decision.mode).toBe("append");
		expect(decision.applyPreset).toBe(true);
	});

	it("does not re-apply when the runtime already matches the applied state", () => {
		const decision = rehydrate(entry(), { tools: ["bash"], model: undefined, thinking: undefined });
		expect(decision.active).toBe(true);
		if (!decision.active) return;
		expect(decision.applyPreset).toBe(false);
	});

	it("leaves a deliberately changed runtime alone", () => {
		const decision = rehydrate(entry(), { tools: ["write"], model: undefined, thinking: undefined });
		expect(decision.active).toBe(true);
		if (!decision.active) return;
		expect(decision.applyPreset).toBe(false);
	});

	it("rejects a missing mode and a null name", () => {
		const parsed = parseSwitchEntry(entry())!;
		const current = { tools: ["read"], model: undefined, thinking: undefined };
		expect(rehydrate({ ...parsed, name: null }, current).active).toBe(false);
		expect(rehydrate({ ...parsed, mode: undefined } as unknown as typeof parsed, current).active).toBe(false);
	});
});

describe("persona: boundary hardening", () => {
	it("dispatchDirective handles every name/known/task combination", () => {
		expect(dispatchDirective({ name: RESET_NAME, known: true, hasTask: true })).toEqual({
			action: "refuse",
			message: `"#${RESET_NAME}" takes no task.`,
		});
		expect(dispatchDirective({ name: RESET_NAME, known: false, hasTask: false })).toEqual({ action: "reset" });
		expect(dispatchDirective({ name: "ghost", known: false, hasTask: false })).toEqual({
			action: "refuse",
			message: 'unknown agent "#ghost".',
		});
		expect(dispatchDirective({ name: "p", known: true, hasTask: false })).toEqual({ action: "switch" });
	});

	it("names the unresolved tools in the switch refusal", () => {
		const outcome = planSwitch(makeAgent({ name: "p", tools: ["ghost"] }), context);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.refusal).toContain("declares tools that do not resolve in the main session");
	});

	it("omits thinking from applied when the definition has none", () => {
		const outcome = planSwitch(makeAgent({ name: "p" }), context);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect("thinking" in outcome.plan.applied).toBe(false);
	});

	it("planReset keeps everything when it still resolves", () => {
		const baseline = snapshotBaseline({ tools: ["read"], model: "anthropic/claude-sonnet-4-5", thinking: "low" });
		expect(planReset(baseline, context)).toEqual({
			tools: ["read"],
			model: "anthropic/claude-sonnet-4-5",
			thinking: "low",
			warnings: [],
		});
	});

	it("rehydrate re-applies the preset only when the runtime is pristine", () => {
		const parsed = parseSwitchEntry(entry())!;
		const applied = parsed.applied ?? {};
		const target = applyOverrides(parsed.baseline, applied);
		const presetFlag = (current: {
			tools: readonly string[];
			model: string | undefined;
			thinking: ThinkingLevel | undefined;
		}) => {
			const decision = rehydrate(parsed, current);
			if (!decision.active) throw new Error("expected an active rehydrate decision");
			return decision.applyPreset;
		};
		expect(presetFlag({ tools: target.tools, model: target.model, thinking: target.thinking })).toBe(false);
		expect(
			presetFlag({ tools: parsed.baseline.tools, model: parsed.baseline.model, thinking: parsed.baseline.thinking }),
		).toBe(true);
		expect(presetFlag({ tools: ["other"], model: "z", thinking: "high" })).toBe(false);
	});
});

describe("persona: survivor kills", () => {
	const bareEntry = {
		name: "p",
		mode: "append",
		baseline: { tools: [], model: undefined, thinking: undefined },
		switchedAt: 1,
	} as const;

	it("accepts a null name, an absent model and an absent applied block", () => {
		expect(parseSwitchEntry({ ...bareEntry, name: null })).toBeDefined();
		expect(parseSwitchEntry(bareEntry)).toBeDefined();
		expect(parseSwitchEntry({ ...bareEntry, baseline: { tools: [] } })?.baseline.model).toBeUndefined();
	});

	it("only reads a matching switch entry", () => {
		expect(lastSwitchEntry([{ type: "custom", customType: "other", data: bareEntry }])).toBeUndefined();
		expect(lastSwitchEntry([{ type: "other", customType: "mx-pi-agents.switch", data: bareEntry }])).toBeUndefined();
		expect(lastSwitchEntry([{ type: "custom", customType: "mx-pi-agents.switch", data: bareEntry }])).toBeDefined();
	});

	it("rehydrates a valid entry as active", () => {
		const parsed = parseSwitchEntry(bareEntry);
		expect(parsed).toBeDefined();
		if (!parsed) return;
		expect(rehydrate(parsed, { tools: [], model: undefined, thinking: undefined }).active).toBe(true);
	});
});

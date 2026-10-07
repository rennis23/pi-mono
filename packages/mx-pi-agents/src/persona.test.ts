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
	availableTools: ["read", "grep", "bash", "edit", "write", "mx_pi_agent"],
	currentTools: ["read", "grep", "bash", "edit", "write"],
	isModelAvailable: (model) => model === "anthropic/claude-sonnet-4-5",
};

describe("dispatchDirective", () => {
	it("treats none as reset and refuses a task", () => {
		expect(dispatchDirective({ name: "none", definition: undefined, hasTask: false })).toEqual({ action: "reset" });
		expect(dispatchDirective({ name: "none", definition: undefined, hasTask: true })).toEqual({
			action: "refuse",
			message: '"#none" takes no task.',
		});
	});

	it("refuses an unknown name", () => {
		expect(dispatchDirective({ name: "ghost", definition: undefined, hasTask: true })).toEqual({
			action: "refuse",
			message: 'unknown agent "#ghost".',
		});
	});

	it("switches for replace and append, with or without a task", () => {
		expect(
			dispatchDirective({ name: "p", definition: { systemPrompt: "replace", subAgentOnly: false }, hasTask: false }),
		).toEqual({
			action: "switch",
			mode: "replace",
		});
		expect(
			dispatchDirective({ name: "m", definition: { systemPrompt: "append", subAgentOnly: false }, hasTask: true }),
		).toEqual({ action: "switch", mode: "append" });
	});

	it("requires a task for a sub-only agent", () => {
		expect(
			dispatchDirective({ name: "s", definition: { systemPrompt: "append", subAgentOnly: true }, hasTask: false }),
		).toEqual({
			action: "refuse",
			message: 'subagent "s" needs a task.',
		});
		expect(
			dispatchDirective({ name: "s", definition: { systemPrompt: "append", subAgentOnly: true }, hasTask: true }),
		).toEqual({ action: "delegate" });
	});
});

describe("planSwitch", () => {
	it("builds a replace plan for a replace agent and an append plan for an append agent", () => {
		const replaceAgent = planSwitch(makeAgent({ name: "p", systemPrompt: "replace", tools: ["read"] }), context);
		expect(replaceAgent.ok).toBe(true);
		if (!replaceAgent.ok) return;
		expect(replaceAgent.plan.mode).toBe("replace");
		expect(replaceAgent.plan.applied.tools).toEqual(["read"]);

		const appendAgent = planSwitch(makeAgent({ name: "m", systemPrompt: "append", tools: ["read"] }), context);
		expect(appendAgent.ok).toBe(true);
		if (!appendAgent.ok) return;
		expect(appendAgent.plan.mode).toBe("append");
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
		const outcome = planSwitch(makeAgent({ name: "p", systemPrompt: "replace", tools: ["read", "ghost"] }), context);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal).toContain("do not resolve in the main session");
		expect(outcome.refusal).toContain("ghost");
	});

	it("refuses the whole switch when a declared model is unavailable", () => {
		const outcome = planSwitch(
			makeAgent({ name: "p", systemPrompt: "replace", model: "openai/gpt-none", thinking: "high" }),
			context,
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal).toContain("not available");
	});

	it("refuses a sub-only definition", () => {
		const outcome = planSwitch(makeAgent({ name: "s", subAgentOnly: true }), context);
		expect(outcome.ok).toBe(false);
	});
});

describe("planSwitch: delegate", () => {
	it("unions mx_pi_agent into a declared tool preset", () => {
		const outcome = planSwitch(
			makeAgent({ name: "o", systemPrompt: "append", tools: ["read"], delegate: true }),
			context,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.applied.tools).toEqual(["read", "mx_pi_agent"]);
	});

	it("yields only mx_pi_agent for an empty declared preset", () => {
		const outcome = planSwitch(makeAgent({ name: "o", systemPrompt: "append", tools: [], delegate: true }), context);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.applied.tools).toEqual(["mx_pi_agent"]);
	});

	it("unions the current active set when tools is absent", () => {
		const outcome = planSwitch(makeAgent({ name: "o", systemPrompt: "append", delegate: true }), context);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.applied.tools).toEqual(["read", "grep", "bash", "edit", "write", "mx_pi_agent"]);
	});

	it("restores delegation when switching from a narrowed agent", () => {
		// After #planner the active set is read-only; the orchestrator declares no
		// preset, so the union must bring mx_pi_agent back.
		const narrowed: SwitchContext = {
			availableTools: ["read", "grep", "find", "ls", "mx_pi_agent"],
			currentTools: ["read", "grep", "find", "ls"],
			isModelAvailable: () => true,
		};
		const outcome = planSwitch(
			makeAgent({ name: "product-builder", systemPrompt: "append", delegate: true }),
			narrowed,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.applied.tools).toEqual(["read", "grep", "find", "ls", "mx_pi_agent"]);
	});

	it("refuses the whole switch when the delegate tool does not resolve", () => {
		const noSpawn: SwitchContext = {
			availableTools: ["read"],
			currentTools: ["read"],
			isModelAvailable: () => true,
		};
		const outcome = planSwitch(
			makeAgent({ name: "o", systemPrompt: "append", tools: ["read"], delegate: true }),
			noSpawn,
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal).toContain("do not resolve in the main session");
		expect(outcome.refusal).toContain("mx_pi_agent");
	});

	it("is byte-identical to today when delegate is false or absent", () => {
		const absent = planSwitch(makeAgent({ name: "p", systemPrompt: "replace", tools: ["read"] }), context);
		const explicitFalse = planSwitch(
			makeAgent({ name: "p", systemPrompt: "replace", tools: ["read"], delegate: false }),
			context,
		);
		expect(absent).toEqual(explicitFalse);
		if (!absent.ok) return;
		expect(absent.plan.applied.tools).toEqual(["read"]);
	});
});

describe("snapshotBaseline / applyOverrides / runtimeMatches", () => {
	it("snapshots and overrides only declared fields", () => {
		const baseline = snapshotBaseline({ tools: ["read"], model: "a/b", thinking: "low" });
		expect(baseline).toEqual({ tools: ["read"], model: "a/b", thinking: "low" });
		const merged = applyOverrides(baseline, { tools: ["bash"] });
		expect(merged).toEqual({ tools: ["bash"], model: "a/b", thinking: "low" });
	});

	it("compares tool sets regardless of order", () => {
		const target: SwitchBaseline = { tools: ["read", "grep"], model: undefined, thinking: undefined };
		expect(runtimeMatches({ tools: ["grep", "read"], model: undefined, thinking: undefined }, target)).toBe(true);
		expect(runtimeMatches({ tools: ["read"], model: undefined, thinking: undefined }, target)).toBe(false);
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
		mode: "replace",
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
		expect(parseSwitchEntry({ name: "p", mode: "sub", switchedAt: 1, baseline: { tools: [] } })).toBeUndefined();
		expect(parseSwitchEntry({ name: "p", switchedAt: 1 })).toBeUndefined();
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

	it("treats an invalid mode as inactive", () => {
		const decision = rehydrate(entry({ mode: "sub" as "replace" | "append" }), {
			tools: ["read"],
			model: undefined,
			thinking: undefined,
		});
		expect(decision).toEqual({ active: false });
	});
});

describe("persona: boundary hardening", () => {
	function validEntry() {
		return {
			name: "p",
			mode: "replace" as const,
			baseline: { tools: ["a"], model: "m", thinking: "low" as const },
			applied: { tools: ["b"], model: "x", thinking: "high" as const },
			switchedAt: 5,
		};
	}

	it("dispatchDirective handles every name/definition/task combination", () => {
		expect(
			dispatchDirective({
				name: RESET_NAME,
				definition: { systemPrompt: "replace", subAgentOnly: false },
				hasTask: true,
			}),
		).toEqual({
			action: "refuse",
			message: `"#${RESET_NAME}" takes no task.`,
		});
		expect(dispatchDirective({ name: RESET_NAME, definition: undefined, hasTask: false })).toEqual({
			action: "reset",
		});
		expect(dispatchDirective({ name: "ghost", definition: undefined, hasTask: false })).toEqual({
			action: "refuse",
			message: 'unknown agent "#ghost".',
		});
		expect(
			dispatchDirective({ name: "s", definition: { systemPrompt: "append", subAgentOnly: true }, hasTask: false }),
		).toEqual({
			action: "refuse",
			message: 'subagent "s" needs a task.',
		});
		expect(
			dispatchDirective({ name: "s", definition: { systemPrompt: "append", subAgentOnly: true }, hasTask: true }),
		).toEqual({ action: "delegate" });
		expect(
			dispatchDirective({ name: "p", definition: { systemPrompt: "replace", subAgentOnly: false }, hasTask: false }),
		).toEqual({
			action: "switch",
			mode: "replace",
		});
		expect(
			dispatchDirective({ name: "m", definition: { systemPrompt: "append", subAgentOnly: false }, hasTask: true }),
		).toEqual({ action: "switch", mode: "append" });
	});

	it("planSwitch refuses a sub-only definition, unresolved tools and unavailable models", () => {
		const subOnly = planSwitch(makeAgent({ name: "sub", subAgentOnly: true }), context);
		expect(subOnly).toEqual({ ok: false, refusal: 'agent "sub" is not a main-session agent.' });

		const badTool = planSwitch(makeAgent({ name: "p", systemPrompt: "replace", tools: ["read", "nope"] }), context);
		expect(badTool.ok).toBe(false);
		if (!badTool.ok) expect(badTool.refusal).toContain("nope");

		const badModel = planSwitch(makeAgent({ name: "p", systemPrompt: "replace", model: "ghost/model" }), context);
		expect(badModel.ok).toBe(false);
		if (!badModel.ok) expect(badModel.refusal).toContain("not available");
	});

	it("planSwitch applies present fields and records the prompt mode", () => {
		const replaceAgent = planSwitch(
			makeAgent({
				name: "p",
				systemPrompt: "replace",
				tools: ["read", "grep"],
				model: "anthropic/claude-sonnet-4-5",
				thinking: "high",
			}),
			context,
		);
		expect(replaceAgent.ok).toBe(true);
		if (!replaceAgent.ok) return;
		expect(replaceAgent.plan.mode).toBe("replace");
		expect(replaceAgent.plan.applied).toEqual({
			tools: ["read", "grep"],
			model: "anthropic/claude-sonnet-4-5",
			thinking: "high",
		});

		const appendAgent = planSwitch(makeAgent({ name: "m", systemPrompt: "append" }), context);
		expect(appendAgent.ok).toBe(true);
		if (!appendAgent.ok) return;
		expect(appendAgent.plan.mode).toBe("append");
		expect(appendAgent.plan.applied).toEqual({});
	});

	it("snapshotBaseline copies the tool list", () => {
		const tools = ["a", "b"];
		const baseline = snapshotBaseline({ tools, model: "m", thinking: "low" });
		expect(baseline).toEqual({ tools: ["a", "b"], model: "m", thinking: "low" });
		tools.push("c");
		expect(baseline.tools).toEqual(["a", "b"]);
	});

	it("applyOverrides prefers applied values, including an empty tool list", () => {
		const baseline = snapshotBaseline({ tools: ["a"], model: "m", thinking: "low" });
		expect(applyOverrides(baseline, {})).toEqual(baseline);
		expect(applyOverrides(baseline, { tools: [], model: "x", thinking: "high" })).toEqual({
			tools: [],
			model: "x",
			thinking: "high",
		});
	});

	it("runtimeMatches compares tools unordered and the rest exactly", () => {
		const target = snapshotBaseline({ tools: ["a", "b"], model: "m", thinking: "low" });
		expect(runtimeMatches({ tools: ["b", "a"], model: "m", thinking: "low" }, target)).toBe(true);
		expect(runtimeMatches({ tools: ["a"], model: "m", thinking: "low" }, target)).toBe(false);
		expect(runtimeMatches({ tools: ["a", "b"], model: "x", thinking: "low" }, target)).toBe(false);
		expect(runtimeMatches({ tools: ["a", "b"], model: "m", thinking: "high" }, target)).toBe(false);
	});

	it("planReset drops unavailable tools and model with warnings", () => {
		const baseline = snapshotBaseline({ tools: ["read", "nope"], model: "ghost", thinking: "low" });
		const plan = planReset(baseline, context);
		expect(plan.tools).toEqual(["read"]);
		expect(plan.model).toBeUndefined();
		expect(plan.thinking).toBe("low");
		expect(plan.warnings.some((w) => w.includes("nope"))).toBe(true);
		expect(plan.warnings.some((w) => w.includes("ghost"))).toBe(true);
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

	it("parseSwitchEntry accepts valid data and normalizes a null model", () => {
		expect(parseSwitchEntry(validEntry())).toEqual(validEntry());
		const entry = parseSwitchEntry({ ...validEntry(), baseline: { tools: ["a"], model: null, thinking: undefined } });
		expect(entry?.baseline.model).toBeUndefined();
	});

	it("parseSwitchEntry allows a null name and rejects malformed shapes", () => {
		expect(parseSwitchEntry(null)).toBeUndefined();
		expect(parseSwitchEntry([])).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), name: null, mode: undefined })?.name).toBeNull();
		expect(parseSwitchEntry({ ...validEntry(), name: 5 })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), mode: "sub" })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), mode: undefined })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), switchedAt: Number.NaN })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), switchedAt: "x" })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), baseline: {} })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), baseline: { tools: [1] } })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), baseline: { tools: [], model: 5 } })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), applied: 5 })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), applied: { tools: [1] } })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), applied: { model: 5 } })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), applied: { thinking: 5 } })).toBeUndefined();
		expect(parseSwitchEntry({ ...validEntry(), applied: undefined })?.applied).toBeUndefined();
	});

	it("lastSwitchEntry returns the last matching custom entry", () => {
		const entries = [
			{ type: "custom", customType: "mx-pi-agents.switch", data: { ...validEntry(), switchedAt: 1 } },
			{ type: "user" },
			{ type: "custom", customType: "other", data: { ...validEntry(), switchedAt: 2 } },
			{ type: "custom", customType: "mx-pi-agents.switch", data: { ...validEntry(), switchedAt: 3 } },
		];
		expect(lastSwitchEntry(entries)?.switchedAt).toBe(3);
		expect(lastSwitchEntry([])).toBeUndefined();
		expect(lastSwitchEntry([{ type: "custom", customType: "other" }])).toBeUndefined();
	});

	it("rehydrate is inactive for missing or invalid entries", () => {
		const current = { tools: ["a"], model: "m", thinking: "low" as const };
		expect(rehydrate(undefined, current).active).toBe(false);
		const entry = parseSwitchEntry(validEntry())!;
		expect(rehydrate({ ...entry, name: null } as unknown as typeof entry, current).active).toBe(false);
		expect(rehydrate({ ...entry, mode: "sub" } as unknown as typeof entry, current).active).toBe(false);
	});

	it("rehydrate re-applies the preset only when the runtime is pristine", () => {
		const entry = parseSwitchEntry(validEntry())!;
		const applied = entry.applied ?? {};
		const target = applyOverrides(entry.baseline, applied);
		const presetFlag = (current: {
			tools: readonly string[];
			model: string | undefined;
			thinking: ThinkingLevel | undefined;
		}) => {
			const decision = rehydrate(entry, current);
			if (!decision.active) throw new Error("expected an active rehydrate decision");
			return decision.applyPreset;
		};
		expect(presetFlag({ tools: target.tools, model: target.model, thinking: target.thinking })).toBe(false);
		expect(
			presetFlag({
				tools: entry.baseline.tools,
				model: entry.baseline.model,
				thinking: entry.baseline.thinking,
			}),
		).toBe(true);
		expect(presetFlag({ tools: ["other"], model: "z", thinking: "high" })).toBe(false);
	});
});

describe("persona: survivor kills", () => {
	it("names the unresolved tools in the switch refusal", () => {
		const outcome = planSwitch(makeAgent({ name: "p", systemPrompt: "replace", tools: ["ghost"] }), context);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.refusal).toContain("declares tools that do not resolve in the main session");
	});

	it("omits thinking from applied when the definition has none", () => {
		const outcome = planSwitch(makeAgent({ name: "p", systemPrompt: "replace" }), context);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect("thinking" in outcome.plan.applied).toBe(false);
	});

	it("runtimeMatches rejects same-length but different tool sets", () => {
		expect(
			runtimeMatches(
				{ tools: ["a", "b"], model: undefined, thinking: undefined },
				{ tools: ["a", "c"], model: undefined, thinking: undefined },
			),
		).toBe(false);
	});

	const entry = {
		name: "p",
		mode: "replace",
		baseline: { tools: [], model: undefined, thinking: undefined },
		switchedAt: 1,
	} as const;

	it("accepts a null name, an absent model and an absent applied block", () => {
		expect(parseSwitchEntry({ ...entry, name: null })).toBeDefined();
		expect(parseSwitchEntry(entry)).toBeDefined();
		expect(parseSwitchEntry({ ...entry, baseline: { tools: [] } })?.baseline.model).toBeUndefined();
	});

	it("rejects a malformed baseline tool list", () => {
		expect(parseSwitchEntry({ ...entry, baseline: { tools: [1] } })).toBeUndefined();
	});

	it("only reads a matching switch entry", () => {
		expect(lastSwitchEntry([{ type: "custom", customType: "other", data: entry }])).toBeUndefined();
		expect(lastSwitchEntry([{ type: "other", customType: "mx-pi-agents.switch", data: entry }])).toBeUndefined();
		expect(lastSwitchEntry([{ type: "custom", customType: "mx-pi-agents.switch", data: entry }])).toBeDefined();
	});

	it("rehydrates a valid replace entry as active", () => {
		const parsed = parseSwitchEntry(entry);
		expect(parsed).toBeDefined();
		if (!parsed) return;
		expect(rehydrate(parsed, { tools: [], model: undefined, thinking: undefined }).active).toBe(true);
	});
});

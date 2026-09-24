import { describe, expect, it } from "vitest";
import { BudgetTracker, budgetStopReason, DEFAULT_BUDGETS, resolveBudgets, usageTotal } from "./budget.js";
import { type Budgets, zeroUsage } from "./types.js";

function budgets(over: Partial<Budgets> = {}): Budgets {
	return { ...DEFAULT_BUDGETS, ...over };
}

describe("DEFAULT_BUDGETS", () => {
	it("caps turns, time and tokens and leaves cost opt-in", () => {
		expect(DEFAULT_BUDGETS).toEqual({
			maxTurns: 30,
			timeoutMs: 600_000,
			tokenBudget: 250_000,
			costBudget: undefined,
		});
	});
});

describe("resolveBudgets", () => {
	it("returns the defaults when nothing is declared", () => {
		expect(resolveBudgets(undefined, undefined)).toEqual(DEFAULT_BUDGETS);
	});

	it("honors a declared value that tightens the default", () => {
		expect(resolveBudgets({ maxTurns: 5 }, undefined).maxTurns).toBe(5);
	});

	it("ignores a declared value looser than the default", () => {
		expect(resolveBudgets({ maxTurns: 99, tokenBudget: 10_000_000 }, undefined)).toMatchObject({
			maxTurns: 30,
			tokenBudget: 250_000,
		});
	});

	it("lets a ceiling tighten the default", () => {
		expect(resolveBudgets(undefined, { maxTurns: 7, timeoutMs: 1000 }).maxTurns).toBe(7);
	});

	it("ignores a ceiling looser than the default", () => {
		expect(resolveBudgets(undefined, { maxTurns: 999, timeoutMs: 9_999_999 })).toMatchObject({
			maxTurns: 30,
			timeoutMs: 600_000,
		});
	});

	it("takes the tighter of declared and ceiling", () => {
		expect(resolveBudgets({ maxTurns: 20 }, { maxTurns: 10 }).maxTurns).toBe(10);
		expect(resolveBudgets({ maxTurns: 5 }, { maxTurns: 50 }).maxTurns).toBe(5);
	});

	it("keeps cost opt-in until one side declares it", () => {
		expect(resolveBudgets(undefined, undefined).costBudget).toBeUndefined();
		expect(resolveBudgets({ costBudget: 2 }, undefined).costBudget).toBe(2);
		expect(resolveBudgets(undefined, { costBudget: 1 }).costBudget).toBe(1);
		expect(resolveBudgets({ costBudget: 5 }, { costBudget: 2 }).costBudget).toBe(2);
	});

	it("ignores invalid declared numbers and stays finite and positive", () => {
		const resolved = resolveBudgets({ maxTurns: -5, timeoutMs: Number.NaN, tokenBudget: 0 }, undefined);
		expect(resolved.maxTurns).toBe(30);
		expect(resolved.timeoutMs).toBe(600_000);
		expect(resolved.tokenBudget).toBe(250_000);
		for (const value of [resolved.maxTurns, resolved.timeoutMs, resolved.tokenBudget]) {
			expect(Number.isFinite(value) && value > 0).toBe(true);
		}
	});

	it("accepts a custom defaults set", () => {
		const custom = budgets({ maxTurns: 4, tokenBudget: 500 });
		expect(resolveBudgets(undefined, undefined, custom)).toEqual(custom);
	});
});

describe("usageTotal", () => {
	it("sums the four billable token fields", () => {
		expect(usageTotal({ ...zeroUsage(), input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })).toBe(100);
	});

	it("ignores negatives and NaN", () => {
		expect(usageTotal({ ...zeroUsage(), input: -10, output: Number.NaN, cacheRead: 2, cacheWrite: 3 })).toBe(5);
	});
});

describe("BudgetTracker", () => {
	it("starts at zero and counts turns", () => {
		let now = 1000;
		const tracker = new BudgetTracker(budgets(), () => now);
		expect(tracker.turns).toBe(0);
		expect(tracker.elapsedMs).toBe(0);
		tracker.noteTurn();
		expect(tracker.turns).toBe(1);
		now = 1500;
		expect(tracker.elapsedMs).toBe(500);
	});

	it("does not breach at exactly the limit", () => {
		let now = 0;
		const tracker = new BudgetTracker(budgets({ maxTurns: 2, timeoutMs: 1000, tokenBudget: 100 }), () => now);
		tracker.noteTurn();
		tracker.noteTurn();
		tracker.noteUsage({ input: 100 });
		now = 1000;
		expect(tracker.check()).toBeUndefined();
	});

	it("breaches the turn budget at 31/30", () => {
		const tracker = new BudgetTracker(budgets(), () => 0);
		for (let i = 0; i < 31; i++) tracker.noteTurn();
		const breach = tracker.check();
		expect(breach).toMatchObject({ kind: "turns", limit: 30, actual: 31 });
		expect(breach?.message).toBe("turn budget exceeded (31/30 turns)");
	});

	it("breaches the time budget the millisecond past the limit", () => {
		let now = 0;
		const tracker = new BudgetTracker(budgets({ timeoutMs: 600_000 }), () => now);
		now = 600_000;
		expect(tracker.check()).toBeUndefined();
		now = 600_001;
		const breach = tracker.check();
		expect(breach).toMatchObject({ kind: "time", limit: 600_000, actual: 600_001 });
		expect(breach?.message).toBe("time budget exceeded (600001ms/600000ms)");
	});

	it("breaches the token budget when usage exceeds it", () => {
		const tracker = new BudgetTracker(budgets({ tokenBudget: 250_000 }), () => 0);
		tracker.noteUsage({ input: 250_001 });
		const breach = tracker.check();
		expect(breach).toMatchObject({ kind: "tokens", limit: 250_000, actual: 250_001 });
		expect(breach?.message).toBe("token budget exceeded (250001/250000 tokens)");
	});

	it("breaches the cost budget when opted in", () => {
		const tracker = new BudgetTracker(budgets({ costBudget: 1 }), () => 0);
		tracker.noteUsage({ cost: 1.005 });
		const breach = tracker.check();
		expect(breach).toMatchObject({ kind: "cost", limit: 1, actual: 1.005 });
		expect(breach?.message).toBe("cost budget exceeded ($1.0050/$1.0000)");
	});

	it("never breaches cost when no budget is set", () => {
		const tracker = new BudgetTracker(budgets(), () => 0);
		tracker.noteUsage({ cost: 999 });
		expect(tracker.check()).toBeUndefined();
	});

	it("reports the first breach in turns -> time -> tokens -> cost order", () => {
		let now = 0;
		const all = new BudgetTracker(budgets({ maxTurns: 1, timeoutMs: 1, tokenBudget: 1, costBudget: 1 }), () => now);
		const time = new BudgetTracker(
			budgets({ maxTurns: 100, timeoutMs: 1, tokenBudget: 1, costBudget: 1 }),
			() => now,
		);
		const tokens = new BudgetTracker(
			budgets({ maxTurns: 100, timeoutMs: 1000, tokenBudget: 1, costBudget: 1 }),
			() => now,
		);
		const cost = new BudgetTracker(
			budgets({ maxTurns: 100, timeoutMs: 1000, tokenBudget: 1000, costBudget: 1 }),
			() => now,
		);

		all.noteTurn();
		all.noteTurn();
		all.noteUsage({ input: 2, cost: 2 });
		time.noteUsage({ input: 2, cost: 2 });
		tokens.noteUsage({ input: 2, cost: 2 });
		cost.noteUsage({ cost: 2 });
		now = 2;

		expect(all.check()?.kind).toBe("turns");
		expect(time.check()?.kind).toBe("time");
		expect(tokens.check()?.kind).toBe("tokens");
		expect(cost.check()?.kind).toBe("cost");
	});

	it("caches the breach across check() calls", () => {
		const tracker = new BudgetTracker(budgets({ maxTurns: 1 }), () => 0);
		tracker.noteTurn();
		tracker.noteTurn();
		const first = tracker.check();
		expect(first).toBeDefined();
		expect(tracker.check()).toBe(first);
		expect(tracker.breach).toBe(first);
	});

	it("clamps noteUsage at zero and tolerates negatives", () => {
		const tracker = new BudgetTracker(budgets(), () => 0);
		tracker.noteUsage({ input: -50, output: Number.NaN, cost: -1 });
		expect(tracker.usage).toMatchObject({ input: 0, output: 0, cost: 0 });
		tracker.noteUsage({ input: 10 });
		expect(tracker.usage.input).toBe(10);
	});
});

describe("budgetStopReason", () => {
	it("maps every breach kind", () => {
		expect(budgetStopReason("turns")).toBe("budget-turns");
		expect(budgetStopReason("time")).toBe("budget-time");
		expect(budgetStopReason("tokens")).toBe("budget-tokens");
		expect(budgetStopReason("cost")).toBe("budget-cost");
	});
});

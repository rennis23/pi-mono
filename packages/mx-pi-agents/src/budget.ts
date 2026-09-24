/**
 * Budget accounting for one child run.
 *
 * Budgets are resolved at plan time (tighten-only against a config ceiling)
 * and enforced at run time by a `BudgetTracker`. Every function here is pure or
 * clock-injected: `check()` is the only side effect and it is deterministic for
 * a given tracker state, so budget enforcement is fully unit-testable.
 */

import { type Budgets, type TokenUsage, zeroUsage } from "./types.js";

/** A limit that was exceeded, with the observed value and a printable message. */
export interface BudgetBreach {
	kind: "turns" | "time" | "tokens" | "cost";
	limit: number;
	actual: number;
	message: string;
}

/**
 * Default hard caps. `costBudget` is opt-in: undefined means "no cost ceiling",
 * because most callers do not want a dollar limit silently applied.
 */
export const DEFAULT_BUDGETS: Budgets = {
	maxTurns: 30,
	timeoutMs: 600_000,
	tokenBudget: 250_000,
	costBudget: undefined,
};

/** True for a usable positive finite limit; negative, zero and NaN are rejected. */
function isSane(n: number | undefined): n is number {
	return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** A token field, ignoring negatives and NaN (treated as 0). */
function nonNegative(n: number | undefined): number {
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Sum of the four billable token fields; negatives and NaN count as 0. */
export function usageTotal(usage: TokenUsage): number {
	return (
		nonNegative(usage.input) +
		nonNegative(usage.output) +
		nonNegative(usage.cacheRead) +
		nonNegative(usage.cacheWrite)
	);
}

/** `min(declared ?? default, ceiling ?? default)`, ignoring invalid inputs. */
function pickLimit(declared: number | undefined, ceiling: number | undefined, fallback: number): number {
	const d = isSane(declared) ? declared : fallback;
	const c = isSane(ceiling) ? ceiling : fallback;
	return Math.min(d, c);
}

/** Cost is opt-in: `undefined` unless either side actually declares a sane value. */
function pickCost(declared: number | undefined, ceiling: number | undefined): number | undefined {
	const d = isSane(declared) ? declared : undefined;
	const c = isSane(ceiling) ? ceiling : undefined;
	if (d === undefined) return c;
	if (c === undefined) return d;
	return Math.min(d, c);
}

/**
 * Resolve an effective budget set. An agent's declared budgets may only tighten
 * the config ceiling: each field is `min(declared, ceiling)`, defaulting the
 * missing/invalid side to `defaults`. A ceiling looser than the default is
 * therefore ignored. Cost stays `undefined` until one side opts in.
 */
export function resolveBudgets(
	declared: Partial<Budgets> | undefined,
	ceilings: Partial<Budgets> | undefined,
	defaults: Budgets = DEFAULT_BUDGETS,
): Budgets {
	return {
		maxTurns: pickLimit(declared?.maxTurns, ceilings?.maxTurns, defaults.maxTurns),
		timeoutMs: pickLimit(declared?.timeoutMs, ceilings?.timeoutMs, defaults.timeoutMs),
		tokenBudget: pickLimit(declared?.tokenBudget, ceilings?.tokenBudget, defaults.tokenBudget),
		costBudget: pickCost(declared?.costBudget, ceilings?.costBudget),
	};
}

/**
 * Mutable accounting for one run. `now` is injected and sampled once at
 * construction so `elapsedMs` is deterministic under a controllable clock.
 */
export class BudgetTracker {
	readonly budgets: Budgets;

	#now: () => number;
	#start: number;
	#turns = 0;
	#usage: TokenUsage;
	#breach: BudgetBreach | undefined;

	constructor(budgets: Budgets, now: () => number) {
		this.budgets = budgets;
		this.#now = now;
		this.#start = now();
		this.#usage = zeroUsage();
	}

	get turns(): number {
		return this.#turns;
	}

	get elapsedMs(): number {
		return this.#now() - this.#start;
	}

	get usage(): TokenUsage {
		return { ...this.#usage };
	}

	/** Record one completed assistant turn. */
	noteTurn(): void {
		this.#turns += 1;
	}

	/** Accumulate token/cost deltas, clamping every field at >= 0. */
	noteUsage(delta: Partial<TokenUsage>): void {
		this.#usage.input = Math.max(0, this.#usage.input + nonNegative(delta.input));
		this.#usage.output = Math.max(0, this.#usage.output + nonNegative(delta.output));
		this.#usage.cacheRead = Math.max(0, this.#usage.cacheRead + nonNegative(delta.cacheRead));
		this.#usage.cacheWrite = Math.max(0, this.#usage.cacheWrite + nonNegative(delta.cacheWrite));
		this.#usage.cost = Math.max(0, this.#usage.cost + nonNegative(delta.cost));
		this.#usage.contextTokens = Math.max(0, nonNegative(delta.contextTokens));
	}

	/**
	 * First breach in order turns → time → tokens → cost, or undefined. The
	 * result is cached: once breached, later calls return the same object even
	 * if a higher-priority limit would now trigger first.
	 */
	check(): BudgetBreach | undefined {
		if (this.#breach) return this.#breach;
		const breach = this.#compute();
		if (breach) this.#breach = breach;
		return breach;
	}

	get breach(): BudgetBreach | undefined {
		return this.check();
	}

	#compute(): BudgetBreach | undefined {
		if (this.#turns > this.budgets.maxTurns) {
			return {
				kind: "turns",
				limit: this.budgets.maxTurns,
				actual: this.#turns,
				message: `turn budget exceeded (${this.#turns}/${this.budgets.maxTurns} turns)`,
			};
		}
		const elapsed = this.elapsedMs;
		if (elapsed > this.budgets.timeoutMs) {
			return {
				kind: "time",
				limit: this.budgets.timeoutMs,
				actual: elapsed,
				message: `time budget exceeded (${elapsed}ms/${this.budgets.timeoutMs}ms)`,
			};
		}
		const tokens = usageTotal(this.#usage);
		if (tokens > this.budgets.tokenBudget) {
			return {
				kind: "tokens",
				limit: this.budgets.tokenBudget,
				actual: tokens,
				message: `token budget exceeded (${tokens}/${this.budgets.tokenBudget} tokens)`,
			};
		}
		const limit = this.budgets.costBudget;
		if (limit !== undefined && this.#usage.cost > limit) {
			return {
				kind: "cost",
				limit,
				actual: this.#usage.cost,
				message: `cost budget exceeded ($${this.#usage.cost.toFixed(4)}/$${limit.toFixed(4)})`,
			};
		}
		return undefined;
	}
}

/** Map a breach kind to the `RunResult.stopped` value it produces. */
export function budgetStopReason(
	kind: BudgetBreach["kind"],
): "budget-turns" | "budget-time" | "budget-tokens" | "budget-cost" {
	switch (kind) {
		case "turns":
			return "budget-turns";
		case "time":
			return "budget-time";
		case "tokens":
			return "budget-tokens";
		case "cost":
			return "budget-cost";
	}
}

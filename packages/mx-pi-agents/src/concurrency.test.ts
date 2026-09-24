import { describe, expect, it } from "vitest";
import {
	MAX_CONCURRENCY,
	MAX_TASKS,
	mapWithConcurrencyLimit,
	normalizeConcurrency,
	taskCountError,
} from "./concurrency.js";

/** A promise resolved/rejected from the outside, so tests need no timers. */
function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("normalizeConcurrency", () => {
	it.each([
		[0, 1],
		[-5, 1],
		[NaN, 1],
		[2.7, 2],
		[100, MAX_CONCURRENCY],
		[undefined, 1],
		[3, 3],
	])("normalizes %o to %i", (input, expected) => {
		expect(normalizeConcurrency(input)).toBe(expected);
	});

	it("never exceeds the hard maximum", () => {
		expect(normalizeConcurrency(Number.MAX_SAFE_INTEGER)).toBe(MAX_CONCURRENCY);
	});
});

describe("taskCountError", () => {
	it("accepts the boundary values", () => {
		expect(taskCountError(0)).toBeUndefined();
		expect(taskCountError(MAX_TASKS)).toBeUndefined();
	});

	it("reports counts above the maximum", () => {
		expect(taskCountError(9)).toBe("too many tasks (9). Max is 8.");
	});

	it("rejects negative and non-integer counts", () => {
		expect(taskCountError(-1)).toBeDefined();
		expect(taskCountError(1.5)).toBeDefined();
	});

	it("honours a custom maximum", () => {
		expect(taskCountError(3, 3)).toBeUndefined();
		expect(taskCountError(4, 3)).toBe("too many tasks (4). Max is 3.");
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("resolves an empty input to an empty array", async () => {
		let calls = 0;
		const result = await mapWithConcurrencyLimit([], 4, async () => {
			calls++;
			return 0;
		});
		expect(result).toEqual([]);
		expect(calls).toBe(0);
	});

	it("preserves input order even when results settle out of order", async () => {
		const items = [0, 1, 2, 3];
		const gates = items.map(() => deferred<string>());
		const promise = mapWithConcurrencyLimit(items, 2, (_item, index) => gates[index].promise);
		for (let i = items.length - 1; i >= 0; i--) gates[i].resolve(`v${i}`);
		expect(await promise).toEqual(["v0", "v1", "v2", "v3"]);
	});

	it.each([2, 4])("preserves order and maps every item with concurrency %i", async (concurrency) => {
		const items = [5, 3, 1, 4, 2, 9, 7];
		const result = await mapWithConcurrencyLimit(items, concurrency, async (n) => n * 2);
		expect(result).toEqual([10, 6, 2, 8, 4, 18, 14]);
	});

	it("never exceeds the concurrency limit even when asked for 100", async () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		const gate = deferred<void>();
		let live = 0;
		let maxLive = 0;
		const promise = mapWithConcurrencyLimit(items, 100, async () => {
			live++;
			maxLive = Math.max(maxLive, live);
			await gate.promise;
			live--;
		});
		expect(maxLive).toBe(MAX_CONCURRENCY);
		gate.resolve(undefined);
		await promise;
		expect(maxLive).toBe(MAX_CONCURRENCY);
		expect(live).toBe(0);
	});

	it("processes more items than workers", async () => {
		const items = [1, 2, 3, 4, 5, 6, 7];
		const result = await mapWithConcurrencyLimit(items, 2, async (n) => n + 1);
		expect(result).toHaveLength(items.length);
		expect(result).toEqual([2, 3, 4, 5, 6, 7, 8]);
	});

	it("passes each item to fn with its correct index", async () => {
		const items = [10, 20, 30, 40];
		const seen = new Map<number, number>();
		const result = await mapWithConcurrencyLimit(items, 2, async (item, index) => {
			seen.set(item, index);
			return index;
		});
		expect(result).toEqual([0, 1, 2, 3]);
		expect(seen.get(10)).toBe(0);
		expect(seen.get(20)).toBe(1);
		expect(seen.get(30)).toBe(2);
		expect(seen.get(40)).toBe(3);
	});

	it("provides a never-aborted signal when the caller passes none", async () => {
		const seen: AbortSignal[] = [];
		await mapWithConcurrencyLimit([1, 2], 2, async (_item, _index, signal) => {
			seen.push(signal);
		});
		expect(seen).toHaveLength(2);
		expect(seen[0].aborted).toBe(false);
	});

	it("rejects before starting any work when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stop"));
		let calls = 0;
		const promise = mapWithConcurrencyLimit(
			[1, 2, 3],
			2,
			async () => {
				calls++;
				return 0;
			},
			controller.signal,
		);
		await expect(promise).rejects.toThrow("stop");
		expect(calls).toBe(0);
	});

	it("stops starting new items after an abort mid-flight", async () => {
		const items = [0, 1, 2, 3, 4, 5];
		const controller = new AbortController();
		const gates = items.map(() => deferred<void>());
		const ran: number[] = [];
		const promise = mapWithConcurrencyLimit(
			items,
			2,
			async (_item, index) => {
				ran.push(index);
				if (ran.length === 2) controller.abort(new Error("stop"));
				await gates[index].promise;
				return index;
			},
			controller.signal,
		);
		// Both in-flight items complete; no further indices are pulled.
		for (const index of [0, 1]) gates[index].resolve(undefined);
		await expect(promise).rejects.toThrow("stop");
		expect(ran).toEqual([0, 1]);
	});

	it("propagates a rejection from fn", async () => {
		const promise = mapWithConcurrencyLimit([1, 2, 3], 2, async (n) => {
			if (n === 2) throw new Error("boom");
			return n;
		});
		await expect(promise).rejects.toThrow("boom");
	});
});

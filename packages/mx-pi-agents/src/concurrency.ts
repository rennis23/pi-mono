/**
 * Bounded concurrency worker pool for the mx-pi-agents extension.
 *
 * The subagent runner fans out child sessions over a caller-supplied list. That
 * fan-out must be bounded: there is no unbounded queue, and an aborted parent
 * must stop starting new work. Both limits live here as pure, total helpers so
 * the runner can be unit-tested without loading pi or a TUI.
 */

/** Hard cap on how many tasks a single fan-out may contain. */
export const MAX_TASKS = 8;

/** Hard cap on how many tasks may run at once. */
export const MAX_CONCURRENCY = 4;

/**
 * Clamp a caller-supplied concurrency to the integer range `1..MAX_CONCURRENCY`.
 *
 * Non-finite input (including `NaN` and `undefined`) falls back to `1` rather
 * than the maximum, so a missing or malformed option is the conservative
 * choice. There is never an unbounded mode.
 */
export function normalizeConcurrency(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	const integer = Math.trunc(value);
	if (integer < 1) return 1;
	if (integer > MAX_CONCURRENCY) return MAX_CONCURRENCY;
	return integer;
}

/**
 * Validate a task count against a maximum (default {@link MAX_TASKS}).
 *
 * Returns `undefined` when `count` is an integer in `0..max`; otherwise an
 * explanatory message. Non-integer and negative counts are rejected too, since
 * neither can describe a real fan-out.
 */
export function taskCountError(count: number, max: number = MAX_TASKS): string | undefined {
	if (!Number.isInteger(count) || count < 0) {
		return `invalid task count (${count}). Must be an integer between 0 and ${max}.`;
	}
	if (count > max) {
		return `too many tasks (${count}). Max is ${max}.`;
	}
	return undefined;
}

/** Turn an aborted signal into the error to reject with. */
function abortReason(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new Error("aborted");
}

/**
 * Map `items` through `fn` with at most `min(normalizeConcurrency(concurrency),
 * items.length)` tasks in flight, preserving input order in the result.
 *
 * Each worker owns an index cursor and pulls the next item in a plain loop, so
 * no queue proportional to `items` is allocated. When `signal` aborts, no
 * further items are started and the promise rejects with the signal's reason
 * (or `new Error("aborted")` when the reason is not an Error). `fn` receives
 * the caller's signal when one is supplied, otherwise a fresh signal that never
 * aborts. A rejection from `fn` rejects the whole call; callers that want
 * all-settled behaviour must catch inside `fn` themselves.
 */
export function mapWithConcurrencyLimit<TIn, TOut>(
	items: readonly TIn[],
	concurrency: number,
	fn: (item: TIn, index: number, signal: AbortSignal) => Promise<TOut>,
	signal?: AbortSignal,
): Promise<TOut[]> {
	const count = items.length;
	const results = new Array<TOut>(count);
	if (count === 0) return Promise.resolve(results);

	const workerCount = Math.min(normalizeConcurrency(concurrency), count);
	const workerSignal = signal ?? new AbortController().signal;

	return new Promise<TOut[]>((resolve, reject) => {
		let nextIndex = 0;
		let remainingWorkers = workerCount;
		let settled = false;

		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};

		const worker = async (): Promise<void> => {
			try {
				while (true) {
					if (settled) return;
					if (workerSignal.aborted) {
						fail(abortReason(workerSignal));
						return;
					}
					const index = nextIndex++;
					if (index >= count) return;
					results[index] = await fn(items[index], index, workerSignal);
				}
			} catch (error) {
				fail(error);
			} finally {
				remainingWorkers--;
				if (remainingWorkers === 0 && !settled) {
					settled = true;
					resolve(results);
				}
			}
		};

		for (let i = 0; i < workerCount; i++) void worker();
	});
}

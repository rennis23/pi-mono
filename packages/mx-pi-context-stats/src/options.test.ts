import { describe, expect, it } from "vitest";
import {
	clampInt,
	DEFAULT_OPTIONS,
	HISTORY_ROWS_MAX,
	HISTORY_ROWS_MIN,
	SUBAGENT_ROWS_MAX,
	withOptions,
} from "./options.js";

describe("clampInt", () => {
	it("passes through in-range integers", () => {
		expect(clampInt(5, 1, 20, 3)).toBe(5);
		expect(clampInt("7", 1, 20, 3)).toBe(7);
	});

	it("clamps to the bounds", () => {
		expect(clampInt(0, 1, 20, 3)).toBe(1);
		expect(clampInt(99, 1, 20, 3)).toBe(20);
	});

	it("falls back on non-numeric input", () => {
		expect(clampInt("abc", 1, 20, 3)).toBe(3);
		expect(clampInt(undefined, 1, 20, 3)).toBe(3);
		expect(clampInt("", 1, 20, 3)).toBe(3);
		expect(clampInt(Number.NaN, 1, 20, 3)).toBe(3);
	});

	it("truncates fractional input", () => {
		expect(clampInt(4.9, 1, 20, 3)).toBe(4);
	});
});

describe("withOptions", () => {
	it("returns an equal copy when nothing is overridden", () => {
		expect(withOptions(DEFAULT_OPTIONS, {})).toEqual(DEFAULT_OPTIONS);
		expect(withOptions(DEFAULT_OPTIONS, {})).not.toBe(DEFAULT_OPTIONS);
	});

	it("bounds history and subagent rows", () => {
		expect(withOptions(DEFAULT_OPTIONS, { historyRows: 999 }).historyRows).toBe(HISTORY_ROWS_MAX);
		expect(withOptions(DEFAULT_OPTIONS, { historyRows: -3 }).historyRows).toBe(HISTORY_ROWS_MIN);
		expect(withOptions(DEFAULT_OPTIONS, { subagentRows: 999 }).subagentRows).toBe(SUBAGENT_ROWS_MAX);
		expect(withOptions(DEFAULT_OPTIONS, { subagentRows: -1 }).subagentRows).toBe(0);
		expect(withOptions(DEFAULT_OPTIONS, { maxWidgetLines: 1 }).maxWidgetLines).toBe(2);
		expect(withOptions(DEFAULT_OPTIONS, { maxWidgetLines: 500 }).maxWidgetLines).toBe(40);
	});

	it("applies boolean overrides", () => {
		expect(withOptions(DEFAULT_OPTIONS, { showHealth: false }).showHealth).toBe(false);
		expect(withOptions(DEFAULT_OPTIONS, { showSubagents: true }).showSubagents).toBe(true);
		expect(withOptions(DEFAULT_OPTIONS, { visible: false }).visible).toBe(false);
	});

	it("accepts a placement", () => {
		expect(withOptions(DEFAULT_OPTIONS, { placement: "aboveEditor" }).placement).toBe("aboveEditor");
	});

	it("drops empty subagent tool names", () => {
		expect(
			withOptions(DEFAULT_OPTIONS, { subagentToolNames: ["spawn_subagent", "", "other"] }).subagentToolNames,
		).toEqual(["spawn_subagent", "other"]);
	});

	it("ignores unknown keys", () => {
		const withExtra = withOptions(DEFAULT_OPTIONS, { nope: 1 } as never);
		expect(withExtra).toEqual(DEFAULT_OPTIONS);
	});
});

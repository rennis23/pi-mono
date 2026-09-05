/**
 * Config store tests. All reads/writes go through a temp file so the tests
 * never touch the real ~/.pi/agent/extensions directory.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigStore, getConfigPath } from "./config.js";
import { DEFAULT_OPTIONS, HISTORY_ROWS_MAX } from "./options.js";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mx-pi-context-stats-"));
	path = join(dir, "extensions", "mx-pi-context-stats.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("getConfigPath", () => {
	it("points at the extensions dir with the expected file name", () => {
		expect(getConfigPath().endsWith(join("extensions", "mx-pi-context-stats.json"))).toBe(true);
	});
});

describe("resolve", () => {
	it("returns defaults when the file is missing", () => {
		expect(createConfigStore(path).resolve()).toEqual(DEFAULT_OPTIONS);
	});

	it("returns defaults when the file is malformed JSON", () => {
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(path, "{ this is not json", "utf8");
		expect(createConfigStore(path).resolve()).toEqual(DEFAULT_OPTIONS);
	});

	it("returns defaults when the file is not an object", () => {
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(path, "[1, 2, 3]", "utf8");
		expect(createConfigStore(path).resolve()).toEqual(DEFAULT_OPTIONS);
	});

	it("merges valid values over the defaults", () => {
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ historyRows: 9, visible: false, placement: "aboveEditor", showHealth: false }),
			"utf8",
		);
		const resolved = createConfigStore(path).resolve();
		expect(resolved.historyRows).toBe(9);
		expect(resolved.visible).toBe(false);
		expect(resolved.placement).toBe("aboveEditor");
		expect(resolved.showHealth).toBe(false);
		// untouched keys keep their defaults
		expect(resolved.showSubagents).toBe(DEFAULT_OPTIONS.showSubagents);
	});

	it("clamps out-of-range numbers instead of trusting the file", () => {
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(path, JSON.stringify({ historyRows: 9999 }), "utf8");
		expect(createConfigStore(path).resolve().historyRows).toBe(HISTORY_ROWS_MAX);
	});

	it("drops an invalid placement rather than rendering an unknown value", () => {
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(path, JSON.stringify({ placement: "sideways" }), "utf8");
		expect(createConfigStore(path).resolve().placement).toBe(DEFAULT_OPTIONS.placement);
	});

	it("ignores unknown keys", () => {
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(path, JSON.stringify({ notAnOption: true, historyRows: 7 }), "utf8");
		const resolved = createConfigStore(path).resolve();
		expect(resolved.historyRows).toBe(7);
		expect("notAnOption" in resolved).toBe(false);
	});
});

describe("save", () => {
	it("creates the parent directory and writes parseable JSON", () => {
		const store = createConfigStore(path);
		const options = { ...DEFAULT_OPTIONS, historyRows: 12 };
		store.save(options);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(options);
	});

	it("round-trips through resolve", () => {
		const store = createConfigStore(path);
		const options = { ...DEFAULT_OPTIONS, placement: "aboveEditor" as const, subagentToolNames: ["a", "b"] };
		store.save(options);
		expect(store.resolve()).toEqual(options);
	});
});

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsStore, getDefaultStorePath, STORE_FILE_NAME, STORE_VERSION } from "./store.js";

const roots: string[] = [];

function makeStore() {
	const root = mkdtempSync(join(tmpdir(), "mx-pi-settings-"));
	roots.push(root);
	return { root, store: createSettingsStore(join(root, "nested", "mx-pi-settings.json")) };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("settings store", () => {
	it("resolves the default file inside PI_CODING_AGENT_DIR/extensions", () => {
		const { root } = makeStore();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		try {
			expect(getDefaultStorePath()).toBe(join(root, "extensions", STORE_FILE_NAME));
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	it("uses an empty document when the file is missing or malformed", () => {
		const { store } = makeStore();
		expect(store.readAll()).toEqual({ version: STORE_VERSION, values: {} });
		mkdirSync(dirname(store.path), { recursive: true });
		writeFileSync(store.path, "not-json");
		expect(store.readNamespace("mx-pi-x")).toEqual({});
		writeFileSync(store.path, JSON.stringify({ version: 1, values: [] }));
		expect(store.readAll().values).toEqual({});
		expect(readdirSync(dirname(store.path))).toEqual(["mx-pi-settings.json"]);
	});

	it("writes atomically, creates parent directories, and keeps sibling namespaces", () => {
		const { root, store } = makeStore();
		store.writeNamespace("mx-pi-a", { enabled: true, count: 4 });
		store.writeNamespace("mx-pi-b", { label: "ok" });
		store.patchNamespace("mx-pi-a", { count: 7 });
		expect(store.readNamespace("mx-pi-a")).toEqual({ enabled: true, count: 7 });
		expect(store.readNamespace("mx-pi-b")).toEqual({ label: "ok" });
		expect(JSON.parse(readFileSync(store.path, "utf8")).version).toBe(STORE_VERSION);
		expect(readdirSync(join(root, "nested")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("preserves unknown primitive keys while filtering non-JSON settings values", () => {
		const { store } = makeStore();
		mkdirSync(dirname(store.path), { recursive: true });
		writeFileSync(
			store.path,
			JSON.stringify({
				version: 1,
				values: { "mx-pi-a": { oldOption: "kept", enabled: true, nested: { x: 1 }, list: [1, 2] } },
			}),
		);
		expect(store.readNamespace("mx-pi-a")).toEqual({ oldOption: "kept", enabled: true });
		store.patchNamespace("mx-pi-a", { newOption: 3 });
		expect(store.readNamespace("mx-pi-a")).toEqual({ oldOption: "kept", enabled: true, newOption: 3 });
	});

	it("removes the temporary file and preserves the error when atomic rename fails", () => {
		const { store } = makeStore();
		mkdirSync(store.path, { recursive: true }); // A directory cannot be replaced by the staged file.
		expect(() => store.writeNamespace("mx-pi-a", { enabled: true })).toThrow();
		expect(readdirSync(dirname(store.path))).toEqual(["mx-pi-settings.json"]);
		expect(readdirSync(store.path)).toEqual([]);
	});

	it("drops non-finite numbers and non-object namespaces loaded from disk", () => {
		const { store } = makeStore();
		mkdirSync(dirname(store.path), { recursive: true });
		writeFileSync(store.path, '{"version":"2","values":{"mx-pi-a":{"inf":1e999,"ok":true},"mx-pi-b":"nope"}}');
		expect(store.readNamespace("mx-pi-a")).toEqual({ ok: true });
		expect(store.readNamespace("mx-pi-b")).toEqual({});
		expect(store.readAll().version).toBe(STORE_VERSION);
	});

	it("clears one namespace without disturbing the others", () => {
		const { store } = makeStore();
		store.writeNamespace("mx-pi-a", { enabled: true });
		store.writeNamespace("mx-pi-b", { count: 2 });
		store.clearNamespace("mx-pi-a");
		expect(store.readNamespace("mx-pi-a")).toEqual({});
		expect(store.readNamespace("mx-pi-b")).toEqual({ count: 2 });
	});
});

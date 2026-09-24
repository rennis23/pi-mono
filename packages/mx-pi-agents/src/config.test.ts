import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONFIG_FILE_NAME,
	createConfigStore,
	defaultConfig,
	isOutsideRoots,
	parseConfig,
	resolveAgentPath,
	serializeConfig,
} from "./config.js";
import type { AgentDiagnostic } from "./types.js";

let root: string;
let agentDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mx-pi-agents-config-"));
	agentDir = join(root, "agent");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function diagnostics(): AgentDiagnostic[] {
	return [];
}

describe("parseConfig", () => {
	it("returns defaults for a non-object", () => {
		const found: AgentDiagnostic[] = [];
		const config = parseConfig("nope", found);
		expect(config).toEqual(defaultConfig());
		expect(found.some((d) => d.level === "warning")).toBe(true);
	});

	it("reads agentPaths, approvals and limits", () => {
		const found = diagnostics();
		const config = parseConfig(
			{
				version: 1,
				agentPaths: ["/one", "  /two  "],
				approvals: { "/dir": { "a.md": { hash: "h", kind: "project", approvedAt: 5 } } },
				limits: { maxTurns: 10, timeoutMs: 5000, tokenBudget: 1000, costBudget: 2.5 },
			},
			found,
		);
		expect(config.agentPaths).toEqual(["/one", "/two"]);
		expect(config.approvals["/dir"]["a.md"]).toEqual({ hash: "h", kind: "project", approvedAt: 5 });
		expect(config.limits).toEqual({ maxTurns: 10, timeoutMs: 5000, tokenBudget: 1000, costBudget: 2.5 });
		expect(found).toEqual([]);
	});

	it("drops malformed agentPaths entries", () => {
		const found = diagnostics();
		const config = parseConfig({ agentPaths: ["/ok", 42, "", null] }, found);
		expect(config.agentPaths).toEqual(["/ok"]);
		expect(found.filter((d) => d.message.includes("agentPaths")).length).toBe(3);
	});

	it("drops malformed approvals without losing valid ones", () => {
		const found = diagnostics();
		const config = parseConfig(
			{
				approvals: {
					"/dir": { good: { hash: "h" }, bad: { nope: true }, alsoBad: "string" },
					"/not-an-object": "nope",
				},
			},
			found,
		);
		expect(Object.keys(config.approvals["/dir"])).toEqual(["good"]);
		expect(config.approvals["/dir"].good.kind).toBe("project");
		expect(found.length).toBeGreaterThanOrEqual(2);
	});

	it("ignores non-positive and non-finite limits", () => {
		const found = diagnostics();
		const config = parseConfig(
			{ limits: { maxTurns: 0, timeoutMs: -5, tokenBudget: Number.NaN, costBudget: 1.5 } },
			found,
		);
		expect(config.limits).toEqual({ costBudget: 1.5 });
	});

	it("floors fractional integer limits", () => {
		const config = parseConfig({ limits: { maxTurns: 10.9 } }, diagnostics());
		expect(config.limits.maxTurns).toBe(10);
	});

	it("notes unknown limit keys", () => {
		const found = diagnostics();
		parseConfig({ limits: { mystery: 1 } }, found);
		expect(found.some((d) => d.message.includes("limits.mystery"))).toBe(true);
	});

	it("notes a version mismatch", () => {
		const found = diagnostics();
		parseConfig({ version: 99 }, found);
		expect(found.some((d) => d.message.includes("version 99"))).toBe(true);
	});
});

describe("serializeConfig", () => {
	it("round-trips through parseConfig", () => {
		const config = defaultConfig();
		config.agentPaths = ["/a"];
		config.limits = { maxTurns: 3 };
		config.approvals = { "/z": { "z.md": { hash: "h", kind: "project", approvedAt: 1 } } };
		const parsed = parseConfig(JSON.parse(serializeConfig(config)), diagnostics());
		expect(parsed).toEqual(config);
	});

	it("sorts keys for a stable file", () => {
		const config = defaultConfig();
		config.approvals = {
			"/b": { "b.md": { hash: "h", kind: "project", approvedAt: 1 } },
			"/a": {
				"z.md": { hash: "h", kind: "project", approvedAt: 1 },
				"a.md": { hash: "h", kind: "project", approvedAt: 1 },
			},
		};
		const text = serializeConfig(config);
		expect(text.indexOf("/a")).toBeLessThan(text.indexOf("/b"));
		expect(text.indexOf("a.md")).toBeLessThan(text.indexOf("z.md"));
	});

	it("ends with a newline", () => {
		expect(serializeConfig(defaultConfig()).endsWith("\n")).toBe(true);
	});
});

describe("resolveAgentPath", () => {
	it("resolves relative entries against the base directory", () => {
		expect(resolveAgentPath("sub/agents", "/base")).toBe("/base/sub/agents");
	});

	it("keeps absolute entries absolute", () => {
		expect(resolveAgentPath("/abs/agents", "/base")).toBe("/abs/agents");
	});

	it("expands a leading tilde", () => {
		const home = process.env.HOME ?? "/base";
		expect(resolveAgentPath("~/agents", "/base")).toBe(join(home, "agents"));
		expect(resolveAgentPath("~", "/base")).toBe(home);
	});
});

describe("createConfigStore", () => {
	it("reports defaults when the file does not exist", () => {
		const store = createConfigStore(agentDir);
		const { config, diagnostics: found } = store.load();
		expect(config).toEqual(defaultConfig());
		expect(found).toEqual([]);
		expect(store.path).toBe(join(agentDir, "extensions", CONFIG_FILE_NAME));
	});

	it("round-trips a saved config with 0600 permissions", () => {
		const store = createConfigStore(agentDir);
		const config = defaultConfig();
		config.agentPaths = ["/extra"];
		config.limits = { maxTurns: 4 };
		store.save(config);

		const mode = statSync(store.path).mode & 0o777;
		expect(mode).toBe(0o600);

		const { config: loaded } = store.load();
		expect(loaded.agentPaths).toEqual(["/extra"]);
		expect(loaded.limits).toEqual({ maxTurns: 4 });
	});

	it("resolves saved relative agentPaths against the config directory", () => {
		const store = createConfigStore(agentDir);
		const config = defaultConfig();
		config.agentPaths = ["../shared/agents"];
		store.save(config);
		const { config: loaded } = store.load();
		expect(loaded.agentPaths).toEqual([join(agentDir, "extensions", "../shared/agents")]);
	});

	it("falls back to defaults with a diagnostic on corrupt JSON", () => {
		const store = createConfigStore(agentDir);
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(store.path, "{ not json");

		const { config, diagnostics: found } = store.load();
		expect(config).toEqual(defaultConfig());
		expect(found.some((d) => d.level === "warning" && d.message.includes("could not read"))).toBe(true);
	});

	it("refuses to read a non-file", () => {
		const store = createConfigStore(agentDir);
		mkdirSync(store.path, { recursive: true });
		const { config, diagnostics: found } = store.load();
		expect(config).toEqual(defaultConfig());
		expect(found.some((d) => d.message.includes("not a regular file"))).toBe(true);
	});

	it("does not leave temp files behind", () => {
		const store = createConfigStore(agentDir);
		store.save(defaultConfig());
		const text = readFileSync(store.path, "utf8");
		expect(text).not.toContain(".tmp-");
	});

	it("overwrites atomically on repeated saves", () => {
		const store = createConfigStore(agentDir);
		const first = defaultConfig();
		first.limits = { maxTurns: 1 };
		store.save(first);
		const second = defaultConfig();
		second.limits = { maxTurns: 2 };
		store.save(second);
		expect(store.load().config.limits).toEqual({ maxTurns: 2 });
	});
});

describe("isOutsideRoots", () => {
	it("is false for a path inside a root and true otherwise", () => {
		// Containment is fail-closed on nonexistent roots, so the root must exist
		// for the inside case to be meaningful.
		mkdirSync(join(root, "repo"), { recursive: true });
		const inside = join(root, "repo", "file.txt");
		const outside = join(tmpdir(), "elsewhere", "file.txt");
		expect(isOutsideRoots(inside, [join(root, "repo")])).toBe(false);
		expect(isOutsideRoots(outside, [join(root, "repo")])).toBe(true);
	});
});

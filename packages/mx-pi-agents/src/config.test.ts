import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileWithStat } from "../test/fs.js";
import {
	APPROVAL_MAX_AGE_MS,
	CONFIG_FILE_NAME,
	CONFIG_VERSION,
	createConfigStore,
	defaultConfig,
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

describe("parseConfig", () => {
	it("returns defaults for a non-object", () => {
		const found: AgentDiagnostic[] = [];
		const config = parseConfig("nope", found);
		expect(config).toEqual(defaultConfig());
		expect(found.some((d) => d.level === "warning")).toBe(true);
	});

	it("reads agentPaths and approvals", () => {
		const found: AgentDiagnostic[] = [];
		const config = parseConfig(
			{
				version: 1,
				agentPaths: ["/one", "  /two  "],
				approvals: { "/dir": { "a.md": { hash: "h", kind: "project", approvedAt: 5 } } },
			},
			found,
		);
		expect(config.agentPaths).toEqual(["/one", "/two"]);
		expect(config.approvals["/dir"]["a.md"]).toEqual({ hash: "h", kind: "project", approvedAt: 5 });
		expect(found).toEqual([]);
	});

	it("drops malformed agentPaths entries", () => {
		const found: AgentDiagnostic[] = [];
		const config = parseConfig({ agentPaths: ["/ok", 42, "", null] }, found);
		expect(config.agentPaths).toEqual(["/ok"]);
		expect(found.filter((d) => d.message.includes("agentPaths")).length).toBe(3);
	});

	it("ignores a non-list agentPaths with a diagnostic", () => {
		const found: AgentDiagnostic[] = [];
		expect(parseConfig({ agentPaths: "nope" }, found).agentPaths).toEqual([]);
		expect(found.some((d) => d.message.includes("agentPaths is not a list"))).toBe(true);
	});

	it("drops malformed approvals without losing valid ones", () => {
		const found: AgentDiagnostic[] = [];
		const config = parseConfig(
			{
				approvals: {
					"/dir": { good: { hash: "h" }, bad: { nope: true }, alsoBad: "string", empty: { hash: "" } },
					"/not-an-object": "nope",
				},
			},
			found,
		);
		expect(Object.keys(config.approvals["/dir"])).toEqual(["good"]);
		expect(config.approvals["/dir"].good.kind).toBe("project");
		expect(config.approvals["/dir"].good.approvedAt).toBe(0);
		expect(found.length).toBeGreaterThanOrEqual(3);
	});

	it("ignores a non-object approvals block", () => {
		const found: AgentDiagnostic[] = [];
		expect(parseConfig({ approvals: 5 }, found).approvals).toEqual({});
		expect(found.some((d) => d.message.includes("approvals is not an object"))).toBe(true);
	});

	it("notes a version mismatch", () => {
		const found: AgentDiagnostic[] = [];
		parseConfig({ version: 99 }, found);
		expect(found.some((d) => d.level === "info" && d.message.includes("version 99"))).toBe(true);
	});

	it("parses each valid kind-of approval entry defensively", () => {
		const config = parseConfig({ approvals: { "/d": { f: { hash: "h", kind: "config", approvedAt: 123 } } } }, []);
		expect(config.approvals["/d"].f).toEqual({ hash: "h", kind: "config", approvedAt: 123 });
	});
});

describe("serializeConfig", () => {
	it("round-trips through parseConfig", () => {
		const config = defaultConfig();
		config.agentPaths = ["/a"];
		config.approvals = { "/z": { "z.md": { hash: "h", kind: "project", approvedAt: 1 } } };
		const parsed = parseConfig(JSON.parse(serializeConfig(config)), []);
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

	it("ends with a newline and keeps the version", () => {
		const text = serializeConfig(defaultConfig());
		expect(text.endsWith("\n")).toBe(true);
		expect(JSON.parse(text).version).toBe(CONFIG_VERSION);
		expect(text).toContain("\n\t");
	});

	it("emits only the documented fields", () => {
		const text = serializeConfig(defaultConfig());
		expect(JSON.parse(text)).toEqual({ version: CONFIG_VERSION, agentPaths: [], approvals: {} });
	});
});

describe("resolveAgentPath", () => {
	it("resolves relative entries against the base directory", () => {
		expect(resolveAgentPath("sub/agents", "/base")).toBe("/base/sub/agents");
	});

	it("keeps absolute entries absolute", () => {
		expect(resolveAgentPath("/abs/agents", "/base")).toBe("/abs/agents");
	});

	it("expands a leading tilde and a bare tilde", () => {
		const previous = process.env.HOME;
		process.env.HOME = "/home/u";
		try {
			expect(resolveAgentPath("~/agents", "/base")).toBe("/home/u/agents");
			expect(resolveAgentPath("~", "/base")).toBe("/home/u");
			expect(resolveAgentPath("rel", "/base")).toBe("/base/rel");
		} finally {
			process.env.HOME = previous;
		}
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
		store.save(config);

		expect(statSync(store.path).mode & 0o777).toBe(0o600);
		expect(store.load().config.agentPaths).toEqual(["/extra"]);
	});

	it("resolves saved relative agentPaths against the config directory", () => {
		const store = createConfigStore(agentDir);
		store.save({ ...defaultConfig(), agentPaths: ["../shared/agents"] });
		expect(store.load().config.agentPaths).toEqual([join(agentDir, "extensions", "../shared/agents")]);
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
		try {
			const { config, diagnostics: found } = store.load();
			expect(config).toEqual(defaultConfig());
			expect(found.some((d) => d.message.includes("not a regular file"))).toBe(true);
		} finally {
			rmSync(store.path, { recursive: true, force: true });
		}
	});

	it("does not leave temp files behind", () => {
		const store = createConfigStore(agentDir);
		store.save(defaultConfig());
		expect(readFileSync(store.path, "utf8")).not.toContain(".tmp-");
	});

	it("overwrites atomically on repeated saves", () => {
		const store = createConfigStore(agentDir);
		store.save({ ...defaultConfig(), agentPaths: ["/one"] });
		store.save({ ...defaultConfig(), agentPaths: ["/two"] });
		expect(store.load().config.agentPaths).toEqual(["/two"]);
	});

	it("save throws when the target path is a directory", () => {
		const store = createConfigStore(agentDir);
		mkdirSync(store.path, { recursive: true });
		try {
			expect(() => store.save(defaultConfig())).toThrow();
		} finally {
			rmSync(store.path, { recursive: true, force: true });
		}
	});

	it("reads a saved file through one descriptor", () => {
		const store = createConfigStore(agentDir);
		store.save(defaultConfig());
		const { content, stats } = readFileWithStat(store.path);
		expect(stats.isFile()).toBe(true);
		expect(content.endsWith("\n")).toBe(true);
	});
});

describe("config: boundary hardening", () => {
	it("APPROVAL_MAX_AGE_MS is exactly 180 days", () => {
		expect(APPROVAL_MAX_AGE_MS).toBe(180 * 24 * 60 * 60 * 1000);
		expect(APPROVAL_MAX_AGE_MS).toBe(15_552_000_000);
	});

	it("defaultConfig is exactly the documented empty shape", () => {
		expect(defaultConfig()).toEqual({ version: CONFIG_VERSION, agentPaths: [], approvals: {} });
	});

	it("drops whitespace-only agentPaths entries", () => {
		const found: AgentDiagnostic[] = [];
		expect(parseConfig({ agentPaths: ["   ", "  real  "] }, found).agentPaths).toEqual(["real"]);
		expect(found.some((d) => d.message.includes("non-string entry"))).toBe(true);
	});

	it("parseConfig treats an array as a non-object", () => {
		const found: AgentDiagnostic[] = [];
		parseConfig([], found);
		expect(found).toHaveLength(1);
	});
});

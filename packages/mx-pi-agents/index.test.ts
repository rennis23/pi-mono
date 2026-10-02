/**
 * End-to-end tests for the extension wiring.
 *
 * These drive the real `index.ts` through the fake pi API: session pinning, the
 * trust gate, mode dispatch, refusal paths and the `/mx-pi-agents` command.
 * No model is called and no session is created — planning and refusals happen
 * before any runner is reached, which is exactly the property under test.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mxPiAgents, { unavailable } from "./index.js";
import { CHILD_TELEMETRY_CHANNEL } from "./src/telemetry.js";
import { createHarness, type Harness, mockTheme } from "./test/harness.js";

// The runner is stubbed for the whole file: no test here creates a real SDK
// session, and the directive suite needs a deterministic successful result.
const inProcessState = vi.hoisted(() => ({
	plans: [] as Array<{ agentName: string; task: string }>,
	/** Optional per-run gate so a test can inspect the UI mid-flight. */
	beforeRun: undefined as
		| undefined
		| ((plan: { agentName: string; task: string }, index: number) => Promise<void> | void),
	/** Telemetry sinks handed to the runner, in call order. */
	telemetry: [] as Array<
		{ delegationId: string; parentSessionId: string; emit: (envelope: unknown) => void } | undefined
	>,
}));

vi.mock("./src/runners/in-process.js", () => ({
	createInProcessRunner: () => ({
		kind: "process",
		run: async (
			plan: { agentName: string; task: string },
			options?: { telemetry?: { delegationId: string; parentSessionId: string; emit: (envelope: unknown) => void } },
		) => {
			const index = inProcessState.plans.length;
			inProcessState.plans.push({ agentName: plan.agentName, task: plan.task });
			inProcessState.telemetry.push(options?.telemetry);
			// Stand in for the child's inline telemetry extension: publish one event.
			options?.telemetry?.emit({
				delegationId: options.telemetry.delegationId,
				parentSessionId: options.telemetry.parentSessionId,
				runId: `run-${index}`,
				agent: plan.agentName,
				type: "message_end",
				event: { type: "message_end" },
			});
			if (inProcessState.beforeRun) await inProcessState.beforeRun(plan, index);
			return {
				agent: plan.agentName,
				ok: true,
				partial: false,
				stopped: undefined,
				text: `handled:${plan.task}`,
				truncated: false,
				durationMs: 1,
				turns: 1,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
				stopReason: "end",
				errorMessage: undefined,
				diagnostics: [],
			};
		},
	}),
}));

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
	inProcessState.plans.length = 0;
	inProcessState.beforeRun = undefined;
	inProcessState.telemetry.length = 0;

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
	it("status reports config path, counts, sandbox availability and scope", async () => {
		await start();
		await harness.runCommand("status");
		const text = harness.notificationText();
		expect(text).toContain("config:");
		expect(text).toContain("agents:");
		expect(text).toContain("scope:");
		expect(text).toContain("unconfined runs: refused");
		expect(text).toContain("sandbox: os");
	});

	it("status shows the configured scope ceiling and whether unconfined runs are allowed", async () => {
		const extensions = join(agentDir, "extensions");
		mkdirSync(extensions, { recursive: true });
		writeFileSync(
			join(extensions, "mx-pi-agents.json"),
			`${JSON.stringify({ version: 1, agentPaths: [], approvals: {}, limits: {}, scope: ["/"] }, null, "\t")}\n`,
		);
		await start();
		await harness.runCommand("status");
		const text = harness.notificationText();
		expect(text).toContain("scope: /");
		expect(text).toContain("unconfined runs: allowed");
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

describe("# directive input handler", () => {
	async function emitInput(payload: Record<string, unknown>): Promise<unknown> {
		return harness.emit("input", { source: "interactive", ...payload });
	}

	it("delegates a single bracketed agent, appends a custom message and triggers a turn", async () => {
		await start();
		const result = await emitInput({ text: "#[explorer] find the config" });

		expect(result).toEqual({ action: "handled" });
		expect(inProcessState.plans).toEqual([{ agentName: "explorer", task: "find the config" }]);
		expect(harness.messages).toHaveLength(1);
		const { message, options } = harness.messages[0];
		expect(message.customType).toBe("mx-pi-agents.directive");
		expect(message.display).toBe(true);
		expect(message.content).toContain("handled:find the config");
		expect(options?.triggerTurn).toBe(true);
		expect((message.details as { mode: string }).mode).toBe("pipeline");
	});

	it("cascades {previous} through a bracketed pipeline", async () => {
		await start();
		const result = await emitInput({ text: "#[planner > explorer] add a health endpoint" });

		expect(result).toEqual({ action: "handled" });
		expect(inProcessState.plans).toEqual([
			{ agentName: "planner", task: "add a health endpoint" },
			{ agentName: "explorer", task: "handled:add a health endpoint" },
		]);
		const details = harness.messages[0].message.details as { mode: string; results: unknown[] };
		expect(details.mode).toBe("pipeline");
		expect(details.results).toHaveLength(2);
	});

	it("switches the main session on a bare directive and sets status", async () => {
		await start();
		const result = await emitInput({ text: "#builder" });

		expect(result).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("switched to main builder");
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents-persona", "main:builder");
		expect(harness.messages).toHaveLength(0);
	});

	it("refuses an unknown agent without reaching the model", async () => {
		await start();
		const result = await emitInput({ text: "#ghost do it" });

		expect(result).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("unknown agent");
		expect(harness.messages).toHaveLength(0);
	});

	it("continues when the extension is disabled", async () => {
		await start();
		harness.flagValues.set("mx-pi-agents-disable", true);
		const result = await emitInput({ text: "#explorer hi" });

		expect(result).toEqual({ action: "continue" });
		expect(harness.messages).toHaveLength(0);
	});

	it("continues for non-interactive sources", async () => {
		await start();
		const result = await harness.emit("input", { text: "#explorer hi", source: "extension" });

		expect(result).toEqual({ action: "continue" });
		expect(harness.messages).toHaveLength(0);
	});

	it("continues for a plain prompt", async () => {
		await start();
		const result = await emitInput({ text: "just a normal question" });

		expect(result).toEqual({ action: "continue" });
		expect(harness.messages).toHaveLength(0);
	});

	it("refuses a directive while streaming", async () => {
		await start();
		const result = await emitInput({ text: "#explorer hi", streamingBehavior: "steer" });

		expect(result).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("wait for the current turn");
		expect(harness.messages).toHaveLength(0);
	});

	it("refuses a directive carrying images", async () => {
		await start();
		const result = await emitInput({
			text: "#explorer hi",
			images: [{ type: "image", data: "x", mimeType: "image/png" }],
		});

		expect(result).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("images");
		expect(harness.messages).toHaveLength(0);
	});

	it("prompts for a gated project agent and switches the main session on approval", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: true, confirmResult: true, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();

		const result = await harness.emit("input", { text: "#local do it", source: "interactive" });

		expect(result).toEqual({ action: "transform", text: "do it" });
		expect(harness.ui.confirm).toHaveBeenCalled();
		expect(harness.ui.confirm.mock.calls[0][1]).toContain("main system prompt");
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents-persona", "main:local");
	});

	it("refuses a switch whose definition changed after pinning", async () => {
		const path = writeAgent(join(agentDir, "agents"), "changing");
		await start();
		writeFileSync(path, "---\nname: changing\ndescription: changed\ntools: [read, bash, write]\n---\n\nWidened.\n");

		const result = await emitInput({ text: "#changing do it" });

		expect(result).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("changed since session start");
		expect(inProcessState.plans).toHaveLength(0);
	});
});

describe("# directive autocomplete", () => {
	function fakeCurrent() {
		return {
			getSuggestions: vi.fn(async () => ({ items: [{ value: "builtin", label: "builtin" }], prefix: "@" })),
			applyCompletion: vi.fn(() => ({ lines: [], cursorLine: 0, cursorCol: 0 })),
			shouldTriggerFileCompletion: vi.fn(() => true),
		};
	}

	async function providerFor() {
		await start();
		const factory = harness.autocompleteFactories[0] as (current: unknown) => {
			getSuggestions: (
				lines: string[],
				line: number,
				col: number,
				options: { signal: AbortSignal },
			) => Promise<{
				items: Array<{ value: string }>;
				prefix: string;
			}>;
		};
		const current = fakeCurrent();
		return { provider: factory(current), current };
	}

	it("suggests agents at a single-name position", async () => {
		const { provider } = await providerFor();
		const result = await provider.getSuggestions(["#bui"], 0, 4, { signal: new AbortController().signal });
		expect(result.items.map((item) => item.value)).toContain("#builder");
		expect(result.prefix).toBe("#bui");
	});

	it("suggests agents inside a pipeline", async () => {
		const { provider } = await providerFor();
		const result = await provider.getSuggestions(["#[planner > bui"], 0, 15, {
			signal: new AbortController().signal,
		});
		expect(result.items.map((item) => item.value)).toContain("builder");
		expect(result.prefix).toBe("bui");
	});

	it("delegates to the built-in provider outside a directive", async () => {
		const { provider, current } = await providerFor();
		const result = await provider.getSuggestions(["@src"], 0, 4, { signal: new AbortController().signal });
		expect(current.getSuggestions).toHaveBeenCalled();
		expect(result.items[0].value).toBe("builtin");
	});
});

describe("# agent progress widget", () => {
	const WIDGET_KEY = "mx-pi-agents-progress";
	const fakeTui = { requestRender: vi.fn() };

	function progressComponent() {
		const factory = harness.widgets.get(WIDGET_KEY) as
			| ((tui: { requestRender: () => void }, theme: typeof mockTheme) => { render: (width: number) => string[] })
			| undefined;
		if (!factory) throw new Error("progress widget was not mounted");
		return factory(fakeTui, mockTheme);
	}

	it("mounts the widget during a run and clears it after", async () => {
		await start();
		let release!: () => void;
		inProcessState.beforeRun = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});

		const run = harness.emit("input", { text: "#[explorer] find it", source: "interactive" });
		await vi.waitFor(() => expect(harness.widgets.has(WIDGET_KEY)).toBe(true));

		const lines = progressComponent().render(80);
		expect(lines.join("\n")).toContain("explorer");
		expect(lines.join("\n")).toContain("Agents (");

		release();
		await expect(run).resolves.toEqual({ action: "handled" });
		expect(harness.widgets.has(WIDGET_KEY)).toBe(false);
	});

	it("shows done and running agents mid-run", async () => {
		await start();
		let release!: () => void;
		inProcessState.beforeRun = (_plan, index) =>
			index === 1
				? new Promise<void>((resolve) => {
						release = resolve;
					})
				: undefined;

		const run = harness.emit("input", { text: "#[explorer > planner] go", source: "interactive" });
		await vi.waitFor(() => expect(inProcessState.plans).toHaveLength(2));
		const rendered = progressComponent().render(80).join("\n");
		expect(rendered).toContain("✓");
		expect(rendered).toContain("explorer");
		expect(rendered).toContain("◐");
		expect(rendered).toContain("planner");

		release();
		await run;
	});

	it("registers the widget above the editor", async () => {
		await start();
		let release!: () => void;
		inProcessState.beforeRun = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const run = harness.emit("input", { text: "#[explorer] hi", source: "interactive" });
		await vi.waitFor(() => expect(harness.widgets.has(WIDGET_KEY)).toBe(true));

		const call = harness.ui.setWidget.mock.calls.find(
			(entry) => entry[0] === WIDGET_KEY && typeof entry[1] === "function",
		);
		expect(call?.[2]).toEqual({ placement: "aboveEditor" });

		await harness.emit("session_shutdown");
		expect(harness.widgets.has(WIDGET_KEY)).toBe(false);
		release();
		await run;
	});

	it("cancels the run on Escape and does not trigger a turn", async () => {
		await start();
		let release!: () => void;
		inProcessState.beforeRun = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});

		const run = harness.emit("input", { text: "#[explorer] hi", source: "interactive" });
		await vi.waitFor(() => expect(harness.terminalHandlers.length).toBeGreaterThan(0));

		const handler = harness.terminalHandlers[0];
		expect(handler("\x1b")).toEqual({ consume: true });
		release();
		await expect(run).resolves.toEqual({ action: "handled" });

		const { message, options } = harness.messages[0];
		expect(message.content).toContain("Cancelled");
		expect(options?.triggerTurn).toBe(false);
		expect(harness.terminalHandlers).toHaveLength(0);
	});
});

describe("child telemetry", () => {
	it("publishes child events on the shared extension event bus", async () => {
		await start();
		const seen: unknown[] = [];
		const unsubscribe = harness.events.on(CHILD_TELEMETRY_CHANNEL, (data) => seen.push(data));
		await harness.emit("input", { text: "#[explorer] hi", source: "interactive" });
		unsubscribe();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			agent: "explorer",
			parentSessionId: "session-test",
			type: "message_end",
		});
	});

	it("shares one delegationId across every agent in a call", async () => {
		await start();
		await harness.emit("input", { text: "#[explorer > planner] go", source: "interactive" });
		const sinks = inProcessState.telemetry.filter((sink) => sink !== undefined);
		expect(sinks).toHaveLength(2);
		expect(sinks[0]?.delegationId).toBe(sinks[1]?.delegationId);
		expect(sinks[0]?.delegationId).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("# main-session switching", () => {
	async function emitInput(payload: Record<string, unknown>): Promise<unknown> {
		return harness.emit("input", { source: "interactive", ...payload });
	}

	function lastSwitchEntry(): { data?: { name?: string | null } } | undefined {
		return harness.branchEntries.filter((entry) => entry.customType === "mx-pi-agents.switch").at(-1) as
			| { data?: { name?: string | null } }
			| undefined;
	}

	it("switches with a task, returns transform and records the switch", async () => {
		writeAgent(join(agentDir, "agents"), "style", "kind: persona\n");
		await start();

		const result = await emitInput({ text: "#style use tabs" });

		expect(result).toEqual({ action: "transform", text: "use tabs" });
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents-persona", "persona:style");
		expect(lastSwitchEntry()?.data).toMatchObject({ name: "style", kind: "persona" });
	});

	it("replaces the prompt prefix for a persona and appends for a main agent", async () => {
		writeAgent(join(agentDir, "agents"), "style", "kind: persona\n");
		writeAgent(join(agentDir, "agents"), "helper");
		await start();

		await emitInput({ text: "#style" });
		const personaOptions: Record<string, unknown> = { customPrompt: undefined, appendSystemPrompt: "BASE" };
		await harness.emit("before_agent_start", { systemPromptOptions: personaOptions, systemPrompt: "", prompt: "" });
		expect(personaOptions.customPrompt).toBe("Body for style.");
		expect(personaOptions.appendSystemPrompt).toBe("BASE");

		await emitInput({ text: "#helper" });
		const mainOptions: Record<string, unknown> = { customPrompt: undefined, appendSystemPrompt: "BASE" };
		await harness.emit("before_agent_start", { systemPromptOptions: mainOptions, systemPrompt: "", prompt: "" });
		expect(mainOptions.customPrompt).toBeUndefined();
		expect(mainOptions.appendSystemPrompt).toBe("BASE\n\nBody for helper.");
	});

	it("narrows skills and context files to the persona's allow-lists", async () => {
		writeAgent(join(agentDir, "agents"), "style", "kind: persona\nskills: [alpha]\ncontext_files: [AGENTS.md]\n");
		await start();
		await emitInput({ text: "#style" });

		const alpha = { name: "alpha", description: "a", filePath: "/skills/alpha/SKILL.md" };
		const kept = { path: join(cwd, "AGENTS.md"), content: "project" };
		const options: Record<string, unknown> = {
			customPrompt: undefined,
			appendSystemPrompt: "",
			skills: [alpha, { name: "beta", description: "b" }],
			contextFiles: [kept, { path: join(cwd, "docs", "notes.md"), content: "notes" }],
		};
		await harness.emit("before_agent_start", { systemPromptOptions: options, systemPrompt: "", prompt: "" });

		expect(options.customPrompt).toBe("Body for style.");
		expect(options.skills).toEqual([alpha]);
		expect(options.contextFiles).toEqual([kept]);
	});

	it("leaves skills and context files untouched when the persona does not declare them", async () => {
		writeAgent(join(agentDir, "agents"), "style", "kind: persona\n");
		await start();
		await emitInput({ text: "#style" });

		const skills = [{ name: "alpha", description: "a" }];
		const contextFiles = [{ path: join(cwd, "AGENTS.md"), content: "project" }];
		const options: Record<string, unknown> = {
			customPrompt: undefined,
			appendSystemPrompt: "",
			skills,
			contextFiles,
		};
		await harness.emit("before_agent_start", { systemPromptOptions: options, systemPrompt: "", prompt: "" });

		expect(options.skills).toEqual(skills);
		expect(options.contextFiles).toEqual(contextFiles);
	});

	it("restores skills and context files after #none", async () => {
		writeAgent(join(agentDir, "agents"), "style", "kind: persona\nskills: []\ncontext_files: []\n");
		await start();
		await emitInput({ text: "#style" });
		await emitInput({ text: "#none" });

		const skills = [{ name: "alpha", description: "a" }];
		const contextFiles = [{ path: join(cwd, "AGENTS.md"), content: "project" }];
		const options: Record<string, unknown> = {
			customPrompt: undefined,
			appendSystemPrompt: "",
			skills,
			contextFiles,
		};
		await harness.emit("before_agent_start", { systemPromptOptions: options, systemPrompt: "", prompt: "" });

		expect(options.skills).toEqual(skills);
		expect(options.contextFiles).toEqual(contextFiles);
	});

	it("resets to plain pi with #none and refuses a task", async () => {
		writeAgent(join(agentDir, "agents"), "style", "kind: persona\n");
		await start();
		await emitInput({ text: "#style" });

		const refused = await emitInput({ text: "#none do it" });
		expect(refused).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("takes no task");

		const result = await emitInput({ text: "#none" });
		expect(result).toEqual({ action: "handled" });
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("mx-pi-agents-persona", undefined);
		expect(lastSwitchEntry()?.data?.name).toBeNull();

		const options: Record<string, unknown> = { customPrompt: undefined, appendSystemPrompt: "" };
		await harness.emit("before_agent_start", { systemPromptOptions: options, systemPrompt: "", prompt: "" });
		expect(options.customPrompt).toBeUndefined();
	});

	it("deactivates the switch when the definition changes mid-session", async () => {
		const path = writeAgent(join(agentDir, "agents"), "style", "kind: persona\n");
		await start();
		await emitInput({ text: "#style" });
		writeFileSync(path, "---\nname: style\ndescription: style description\nkind: persona\n---\n\nEVIL\n");

		const options: Record<string, unknown> = { customPrompt: undefined, appendSystemPrompt: "" };
		await harness.emit("before_agent_start", { systemPromptOptions: options, systemPrompt: "", prompt: "" });
		expect(options.customPrompt).toBeUndefined();
		expect(harness.notificationText()).toContain("main-prompt switch was cancelled");
	});

	it("rehydrates a persisted switch on session start", async () => {
		writeAgent(join(agentDir, "agents"), "style", "kind: persona\n");
		harness = createHarness({
			cwd,
			activeTools: ["read", "grep", "bash"],
			branch: [
				{
					type: "custom",
					customType: "mx-pi-agents.switch",
					data: {
						name: "style",
						kind: "persona",
						baseline: { tools: ["read", "grep", "bash"], model: undefined, thinking: "medium" },
						applied: {},
						switchedAt: 1,
					},
				},
			],
		});
		mxPiAgents(harness.pi);
		await start();

		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents-persona", "persona:style");
		const options: Record<string, unknown> = { customPrompt: undefined, appendSystemPrompt: "" };
		await harness.emit("before_agent_start", { systemPromptOptions: options, systemPrompt: "", prompt: "" });
		expect(options.customPrompt).toBe("Body for style.");
	});

	it("delegates a sub agent and refuses a bare sub", async () => {
		writeAgent(join(agentDir, "agents"), "worker", "kind: sub\n");
		await start();

		const bare = await emitInput({ text: "#worker" });
		expect(bare).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("needs a task");

		const result = await emitInput({ text: "#worker do it" });
		expect(result).toEqual({ action: "handled" });
		expect(inProcessState.plans).toEqual([{ agentName: "worker", task: "do it" }]);
		expect(harness.messages).toHaveLength(1);
	});

	it("applies a delegating orchestrator switch and keeps mx_pi_agent active", async () => {
		harness = createHarness({
			cwd,
			activeTools: ["read", "grep", "bash"],
			allTools: ["read", "grep", "find", "ls", "mx_pi_agent"],
		});
		mxPiAgents(harness.pi);
		await start();

		const result = await emitInput({ text: "#productbuilder ship it" });

		expect(result).toEqual({ action: "transform", text: "ship it" });
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents-persona", "main:productbuilder");
		expect(harness.activeTools()).toEqual(["read", "grep", "find", "ls", "mx_pi_agent"]);
	});

	it("refuses a persona as a child through the tool and a pipeline", async () => {
		writeAgent(join(agentDir, "agents"), "style", "kind: persona\n");
		await start();

		const toolResult = (await harness.runTool("mx_pi_agent", { agent: "style", task: "do it" })) as ToolResult;
		expect(textOf(toolResult)).toContain("main session");
		expect(toolResult.isError).toBe(true);

		await emitInput({ text: "#[style] do it" });
		const details = harness.messages.at(-1)?.message.details as { refusalReason?: string };
		expect(details.refusalReason).toContain("main session");
	});
});

describe("mutation-hardening: index wiring", () => {
	const emitInput = (payload: Record<string, unknown>) => harness.emit("input", { source: "interactive", ...payload });

	it("publishes the tool metadata contract", () => {
		const tool = harness.tools.get("mx_pi_agent") as unknown as Record<string, unknown>;
		expect(tool.label).toBe("mx_pi_agent");
		expect(tool.executionMode).toBe("parallel");
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(tool.namespace).toEqual({ name: "mx-pi-agents", description: "Secure agent delegation" });
		expect(String(tool.description)).toContain("Delegate a task to a named agent");
		expect(harness.commands.get("mx-pi-agents")?.description).toContain("Inspect and approve");
	});

	it("unavailable builds the failure result shape", () => {
		const result = unavailable();
		expect(result.agent).toBe("(none)");
		expect(result.ok).toBe(false);
		expect(result.stopped).toBe("child-error");
		expect(result.errorMessage).toBe("unavailable");
		expect(result.usage.input).toBe(0);
	});

	it("lists the roster for the empty and list commands", async () => {
		writeAgent(join(agentDir, "agents"), "listed");
		await start();
		await harness.runCommand("");
		expect(harness.notificationText()).toContain("listed");
		harness.notifications.length = 0;
		await harness.runCommand("list");
		expect(harness.notificationText()).toContain("listed");
	});

	it("approves a named gated agent after confirmation", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "gated");
		await start();
		harness.ui.confirm.mockResolvedValue(true);
		await harness.runCommand("approve gated");
		expect(harness.notificationText()).toContain("approved 1 agent(s)");
	});

	it("reports unknown, empty and declined approvals", async () => {
		await start();
		await harness.runCommand("approve ghost");
		expect(harness.notificationText()).toContain('No gated agent named "ghost"');
		await harness.runCommand("approve");
		expect(harness.notificationText()).toContain("No gated agents to approve.");

		writeAgent(join(cwd, ".pi", "agents"), "gated");
		await harness.runCommand("refresh");
		harness.ui.confirm.mockResolvedValue(false);
		await harness.runCommand("approve");
		expect(harness.notificationText()).toContain("no approvals changed");
	});

	it("switches to a persona with a provider-qualified model", async () => {
		writeAgent(join(agentDir, "agents"), "styled", "kind: persona\nmodel: anthropic/claude-sonnet-4-5\n");
		await start();
		const result = await emitInput({ text: "#styled" });
		expect(result).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("switched to persona styled");
	});

	it("refuses a persona whose bare model does not resolve", async () => {
		writeAgent(join(agentDir, "agents"), "styled", "kind: persona\nmodel: bare-model\n");
		await start();
		await emitInput({ text: "#styled" });
		expect(harness.notificationText()).toContain("not available");
	});

	it("runs parallel and chain modes through the tool", async () => {
		writeAgent(join(agentDir, "agents"), "alpha");
		writeAgent(join(agentDir, "agents"), "beta");
		await start();
		const parallel = (await harness.runTool("mx_pi_agent", {
			tasks: [
				{ agent: "alpha", task: "t1" },
				{ agent: "beta", task: "t2" },
			],
		})) as ToolResult;
		expect(textOf(parallel)).toContain("handled:t1");
		const chain = (await harness.runTool("mx_pi_agent", {
			chain: [
				{ agent: "alpha", task: "first" },
				{ agent: "beta", task: "use {previous}" },
			],
		})) as ToolResult;
		expect(textOf(chain)).toContain("handled:use handled:first");
	});

	it("refuses invalid tool parameters", async () => {
		await start();
		const result = (await harness.runTool("mx_pi_agent", {})) as ToolResult;
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Invalid parameters");
	});

	it("autocomplete delegates outside a directive and returns items inside one", async () => {
		writeAgent(join(agentDir, "agents"), "wired");
		await start();
		const factory = harness.autocompleteFactories[0] as (current: unknown) => Record<string, unknown>;
		const inner = { items: [{ value: "builtin" }], prefix: "" };
		const current = {
			getSuggestions: vi.fn(async () => inner),
			applyCompletion: vi.fn(() => "applied"),
			shouldTriggerFileCompletion: vi.fn(() => true),
		};
		const provider = factory(current);
		const getSuggestions = provider.getSuggestions as (
			lines: string[],
			line: number,
			col: number,
			options: unknown,
		) => Promise<unknown>;
		expect(await getSuggestions(["hello"], 0, 5, {})).toBe(inner);
		const inside = (await getSuggestions(["#wir"], 0, 4, {})) as { items: unknown[] };
		expect(inside.items.length).toBeGreaterThan(0);
		expect((provider.applyCompletion as (...args: unknown[]) => unknown)([], 0, 0, {}, "")).toBe("applied");
		expect(
			(provider.shouldTriggerFileCompletion as (lines: string[], line: number, col: number) => boolean)([], 0, 0),
		).toBe(true);
	});
});

describe("mutation-hardening: command and description strings", () => {
	it("prints the full USAGE for invalid tool parameters", async () => {
		await start();
		const result = (await harness.runTool("mx_pi_agent", {})) as ToolResult;
		const text = textOf(result);
		expect(text).toContain("Usage: /mx-pi-agents");
		expect(text).toContain("show the roster with source, trust and pinned hash");
		expect(text).toContain("review and approve gated");
		expect(text).toContain("show config path, limits and sandbox availability");
		expect(text).toContain("re-pin the registry from disk");
	});

	it("prints USAGE for an unknown command", async () => {
		await start();
		await harness.runCommand("nonsense");
		expect(harness.notificationText()).toContain("Usage: /mx-pi-agents");
	});

	it("describes the capability and modes in the tool description", () => {
		const desc = harness.tools.get("mx_pi_agent")?.description ?? "";
		expect(desc).toContain("out-of-scope read, write or search is refused");
		expect(desc).toContain("single ({agent, task})");
		expect(desc).toContain("parallel ({tasks: [...]}, max 8)");
		expect(desc).toContain("chain ({chain: [...]}, {previous} substitution)");
		expect(desc).toContain("project agents require approval");
	});

	it("status prints (none) for empty agent paths", async () => {
		await start();
		await harness.runCommand("status");
		expect(harness.notificationText()).toContain("agentPaths: (none)");
	});

	it("parses repeated whitespace in command args", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "one");
		harness = createHarness({ cwd, activeTools: ["read"], confirmResult: true });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("approve   one");
		expect(harness.notificationText()).toContain("approved 1 agent(s)");
	});

	it("approve with a name only targets that gated agent", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "one");
		writeAgent(join(cwd, ".pi", "agents"), "two");
		harness = createHarness({ cwd, activeTools: ["read"], confirmResult: true });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("approve two");
		expect(harness.notificationText()).toContain("approved 1 agent(s)");
		const saved = JSON.parse(readFileSync(join(agentDir, "extensions", "mx-pi-agents.json"), "utf8")) as {
			approvals: Record<string, Record<string, unknown>>;
		};
		const files = Object.values(saved.approvals).flatMap((byFile) => Object.keys(byFile));
		expect(files).toEqual(["two.md"]);
	});

	it("renders (no output) when a result has no details and no text", () => {
		const tool = harness.tools.get("mx_pi_agent");
		const component = tool?.renderResult?.({ content: [], details: undefined }, {}, mockTheme, {}) as {
			render: (width: number) => string[];
		};
		expect(component.render(80).join("\n")).toContain("(no output)");
	});
});

describe("mutation-hardening: status, approvals and unavailable", () => {
	it("status lists configured agentPaths", async () => {
		const extensions = join(agentDir, "extensions");
		mkdirSync(extensions, { recursive: true });
		writeFileSync(
			join(extensions, "mx-pi-agents.json"),
			`${JSON.stringify({ version: 1, agentPaths: ["/custom/agents"], approvals: {}, limits: {} }, null, "\t")}\n`,
		);
		harness = createHarness({ cwd, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("status");
		expect(harness.notificationText()).toContain("agentPaths: /custom/agents");
	});

	it("reports no gated agent for an unknown approve name", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "one");
		harness = createHarness({ cwd, activeTools: ["read"], confirmResult: true });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("approve ghost");
		expect(harness.notificationText()).toContain('No gated agent named "ghost"');
	});

	it("unavailable returns the child-error shape", () => {
		const result = unavailable();
		expect(result.agent).toBe("(none)");
		expect(result.ok).toBe(false);
		expect(result.partial).toBe(false);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("");
		expect(result.stopped).toBe("child-error");
	});
});

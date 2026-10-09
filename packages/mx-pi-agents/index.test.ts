/**
 * End-to-end tests for the extension wiring.
 *
 * These drive the real `index.ts` through the fake pi API: session pinning, the
 * trust gate, default-persona application, the `#` directive switch paths and
 * the `/mx-pi-agents` command. No model is called — planning and refusals
 * happen before any preset is applied, which is exactly the property under test.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mxPiAgents from "./index.js";
import { createHarness, type Harness, mockTheme } from "./test/harness.js";

const settingsState = vi.hoisted(() => ({
	values: { defaultPersona: "" } as Record<string, string>,
	spec: undefined as
		| undefined
		| {
				id: string;
				title: string;
				fields: Array<{ key: string; default: unknown }>;
				onChange?: (values: { defaultPersona: string }) => void;
		  },
}));

vi.mock("@rennis23/mx-pi-settings", () => ({
	registerSettings: (_pi: unknown, spec: NonNullable<typeof settingsState.spec>) => {
		settingsState.spec = spec;
		const defaults: Record<string, unknown> = {};
		for (const field of spec.fields) defaults[field.key] = field.default;
		return {
			id: spec.id,
			values: () => ({ ...defaults, ...settingsState.values }),
			get: (key: string) => ({ ...defaults, ...settingsState.values })[key],
			set: (key: string, value: unknown) => {
				settingsState.values[key] = String(value);
				spec.onChange?.({ ...defaults, ...settingsState.values } as { defaultPersona: string });
				return { ok: true, values: {} };
			},
			reset: () => ({ ok: true, values: {} }),
			dispose: () => {},
		};
	},
}));

/** Drive the settings `onChange` callback the way the hub would. */
function setDefaultPersona(value: string): void {
	settingsState.values.defaultPersona = value;
	settingsState.spec?.onChange?.({ defaultPersona: value });
}

let root: string;
let agentDir: string;
let cwd: string;
let harness: Harness;
let previousAgentDir: string | undefined;

function writeAgent(dir: string, name: string, extra = ""): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.md`);
	const lines = [`name: ${name}`, `description: ${name} description`];
	if (!extra.includes("tools:")) lines.push("tools: [read]");
	writeFileSync(path, `---\n${lines.join("\n")}\n${extra}---\n\nBody for ${name}.\n`);
	return path;
}

function lastSwitchEntry(): { data?: { name?: string | null; mode?: string } } | undefined {
	return harness.branchEntries.filter((entry) => entry.customType === "mx-pi-agents.switch").at(-1) as
		| { data?: { name?: string | null; mode?: string } }
		| undefined;
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
	settingsState.values.defaultPersona = "";

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

function emitInput(payload: Record<string, unknown>): Promise<unknown> {
	return harness.emit("input", { source: "interactive", ...payload });
}

async function emitBeforeAgentStart(options: Record<string, unknown>): Promise<Record<string, unknown>> {
	await harness.emit("before_agent_start", { systemPromptOptions: options, systemPrompt: "", prompt: "" });
	return options;
}

describe("registration", () => {
	it("registers the command, flags and settings, but no tool", () => {
		expect(harness.commands.has("mx-pi-agents")).toBe(true);
		expect(harness.flags.has("mx-pi-agents-list")).toBe(true);
		expect(harness.flags.has("mx-pi-agents-disable")).toBe(true);
		expect(settingsState.spec?.id).toBe("mx-pi-agents");
		expect(settingsState.spec?.title).toBe("Agents");
		expect(settingsState.spec?.fields.map((field) => field.key)).toEqual(["defaultPersona"]);
		expect((harness.pi as unknown as { registerTool?: unknown }).registerTool).toBeUndefined();
	});

	it("does not touch the target repository", async () => {
		await start();
		expect(existsSync(join(cwd, ".pi"))).toBe(false);
	});
});

describe("session_start", () => {
	it("pins the bundled roster and lists it with the flag", async () => {
		harness.flagValues.set("mx-pi-agents-list", true);
		await start();
		expect(harness.notificationText()).toContain("socrates");
		expect(harness.notificationText()).toContain("trusted");
	});

	it("notifies about a corrupt config file", async () => {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "mx-pi-agents.json"), "{ broken");
		await start();
		expect(harness.notificationText()).toContain("could not read");
	});

	it("registers the autocomplete provider only in TUI mode", async () => {
		await start();
		expect(harness.autocompleteFactories).toHaveLength(1);

		const headless = createHarness({ cwd, mode: "rpc" });
		mxPiAgents(headless.pi);
		await headless.emit("session_start", { reason: "startup" });
		expect(headless.autocompleteFactories).toHaveLength(0);
	});
});

describe("default persona", () => {
	it("applies a trusted default persona at session start", async () => {
		setDefaultPersona("socrates");
		await start();
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents", "replace:socrates");
		expect(harness.notificationText()).toContain("switched to replace persona socrates");
	});

	it("reads the stored default persona at session start even without onChange", async () => {
		settingsState.values.defaultPersona = "socrates";
		await start();
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents", "replace:socrates");
	});

	it("notifies and stays plain for an unknown default persona", async () => {
		setDefaultPersona("ghost");
		await start();
		expect(harness.notificationText()).toContain("unknown");
		expect(harness.ui.setStatus).not.toHaveBeenCalledWith("mx-pi-agents", expect.stringContaining("ghost"));
	});

	it("runs the approval flow for a gated default persona", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, activeTools: ["read"], confirmResult: true });
		mxPiAgents(harness.pi);
		setDefaultPersona("local");
		await start();
		expect(harness.ui.confirm).toHaveBeenCalled();
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents", "append:local");
	});

	it("leaves a declined gated default persona unapplied", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, activeTools: ["read"], confirmResult: false });
		mxPiAgents(harness.pi);
		setDefaultPersona("local");
		await start();
		expect(harness.ui.setStatus).not.toHaveBeenCalledWith("mx-pi-agents", "append:local");
	});

	it("does not re-apply the default persona over a rehydrated switch", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		harness = createHarness({
			cwd,
			activeTools: ["read"],
			branch: [
				{
					type: "custom",
					customType: "mx-pi-agents.switch",
					data: {
						name: "style",
						mode: "replace",
						baseline: { tools: ["read"], model: undefined, thinking: "medium" },
						applied: {},
						switchedAt: 1,
					},
				},
			],
		});
		mxPiAgents(harness.pi);
		setDefaultPersona("socrates");
		await start();
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents", "replace:style");
	});
});

describe("# directive switching", () => {
	it("switches with a task, returns transform and records the mode", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		await start();

		const result = await emitInput({ text: "#style use tabs" });

		expect(result).toEqual({ action: "transform", text: "use tabs" });
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents", "replace:style");
		expect(lastSwitchEntry()?.data).toMatchObject({ name: "style", mode: "replace" });
	});

	it("switches without a task and notifies", async () => {
		writeAgent(join(agentDir, "agents"), "helper");
		await start();
		expect(await emitInput({ text: "#helper" })).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("switched to append persona helper");
		expect(lastSwitchEntry()?.data).toMatchObject({ name: "helper", mode: "append" });
	});

	it("replaces the prompt prefix for replace and appends for append", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		writeAgent(join(agentDir, "agents"), "helper");
		await start();

		await emitInput({ text: "#style" });
		const replaceOptions = await emitBeforeAgentStart({ customPrompt: undefined, appendSystemPrompt: "BASE" });
		expect(replaceOptions.customPrompt).toBe("Body for style.");
		expect(replaceOptions.appendSystemPrompt).toBe("BASE");

		await emitInput({ text: "#helper" });
		const appendOptions = await emitBeforeAgentStart({ customPrompt: undefined, appendSystemPrompt: "BASE" });
		expect(appendOptions.customPrompt).toBeUndefined();
		expect(appendOptions.appendSystemPrompt).toBe("BASE\n\nBody for helper.");
	});

	it("narrows skills and context files to the definition's allow-lists", async () => {
		writeAgent(
			join(agentDir, "agents"),
			"style",
			"system_prompt: replace\nskills: [alpha]\ncontext_files: [AGENTS.md]\n",
		);
		await start();
		await emitInput({ text: "#style" });

		const alpha = { name: "alpha", description: "a", filePath: "/skills/alpha/SKILL.md" };
		const kept = { path: join(cwd, "AGENTS.md"), content: "project" };
		const options = await emitBeforeAgentStart({
			customPrompt: undefined,
			appendSystemPrompt: "",
			skills: [alpha, { name: "beta", description: "b" }],
			contextFiles: [kept, { path: join(cwd, "docs", "notes.md"), content: "notes" }],
		});

		expect(options.skills).toEqual([alpha]);
		expect(options.contextFiles).toEqual([kept]);
	});

	it("leaves skills and context files untouched when undeclared", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		await start();
		await emitInput({ text: "#style" });

		const skills = [{ name: "alpha", description: "a" }];
		const contextFiles = [{ path: join(cwd, "AGENTS.md"), content: "project" }];
		const options = await emitBeforeAgentStart({
			customPrompt: undefined,
			appendSystemPrompt: "",
			skills,
			contextFiles,
		});
		expect(options.skills).toEqual(skills);
		expect(options.contextFiles).toEqual(contextFiles);
	});

	it("empties resources when the definition declares empty allow-lists", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\nskills: []\ncontext_files: []\n");
		await start();
		await emitInput({ text: "#style" });

		const options = await emitBeforeAgentStart({
			customPrompt: undefined,
			appendSystemPrompt: "",
			skills: [{ name: "alpha", description: "a" }],
			contextFiles: [{ path: join(cwd, "AGENTS.md"), content: "project" }],
		});
		expect(options.skills).toEqual([]);
		expect(options.contextFiles).toEqual([]);
	});

	it("resets to plain pi with #none and restores the baseline", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\ntools: [read]\n");
		await start();
		const before = harness.activeTools();
		await emitInput({ text: "#style" });
		expect(harness.activeTools()).toEqual(["read"]);

		const refused = await emitInput({ text: "#none do it" });
		expect(refused).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("takes no task");

		const result = await emitInput({ text: "#none" });
		expect(result).toEqual({ action: "handled" });
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("mx-pi-agents", undefined);
		expect(lastSwitchEntry()?.data?.name).toBeNull();
		expect(harness.activeTools()).toEqual(before);
	});

	it("refuses an unknown agent without reaching the model", async () => {
		await start();
		expect(await emitInput({ text: "#ghost do it" })).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("unknown agent");
	});

	it("refuses a malformed bracketed directive", async () => {
		await start();
		expect(await emitInput({ text: "#[socrates] do it" })).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("bracketed pipelines were removed");
	});

	it("prompts for a gated project agent and switches on approval", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, activeTools: ["read"], confirmResult: true });
		mxPiAgents(harness.pi);
		await start();

		const result = await emitInput({ text: "#local do it" });

		expect(result).toEqual({ action: "transform", text: "do it" });
		expect(harness.ui.confirm).toHaveBeenCalled();
		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents", "append:local");
	});

	it("refuses an unapproved gated agent headlessly", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, hasUI: false, activeTools: ["read"] });
		mxPiAgents(harness.pi);
		await start();

		expect(await emitInput({ text: "#local do it" })).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("no matching approval");
	});

	it("refuses a switch whose declared tool does not resolve", async () => {
		writeAgent(join(agentDir, "agents"), "bad", "tools: [read, ghost]\n");
		await start();
		expect(await emitInput({ text: "#bad" })).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("do not resolve");
	});

	it("refuses a switch whose definition changed after pinning", async () => {
		const path = writeAgent(join(agentDir, "agents"), "changing", "system_prompt: replace\n");
		await start();
		writeFileSync(path, "---\nname: changing\ndescription: changed\nsystem_prompt: replace\n---\n\nChanged.\n");

		expect(await emitInput({ text: "#changing do it" })).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("changed since session start");
	});

	it("continues when the extension is disabled", async () => {
		await start();
		harness.flagValues.set("mx-pi-agents-disable", true);
		expect(await emitInput({ text: "#socrates hi" })).toEqual({ action: "continue" });
	});

	it("continues for non-interactive sources and plain prompts", async () => {
		await start();
		expect(await harness.emit("input", { text: "#socrates hi", source: "extension" })).toEqual({
			action: "continue",
		});
		expect(await emitInput({ text: "just a normal question" })).toEqual({ action: "continue" });
	});

	it("refuses a directive while streaming or carrying images", async () => {
		await start();
		expect(await emitInput({ text: "#socrates hi", streamingBehavior: "steer" })).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("wait for the current turn");

		harness.notifications.length = 0;
		expect(
			await emitInput({ text: "#socrates hi", images: [{ type: "image", data: "x", mimeType: "image/png" }] }),
		).toEqual({ action: "handled" });
		expect(harness.notificationText()).toContain("images");
	});
});

describe("preset application", () => {
	it("applies model and thinking", async () => {
		writeAgent(
			join(agentDir, "agents"),
			"styled",
			"system_prompt: replace\nmodel: anthropic/claude-sonnet-4-5\nthinking: high\n",
		);
		await start();
		await emitInput({ text: "#styled" });
		expect(harness.modelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
		expect(harness.pi.setModel).toHaveBeenCalled();
		expect(harness.currentThinking()).toBe("high");
	});

	it("resolves a bare model through getAll", async () => {
		harness.modelRegistry.getAll.mockReturnValue([{ provider: "openai", id: "gpt-x" }]);
		writeAgent(join(agentDir, "agents"), "styled", "system_prompt: replace\nmodel: gpt-x\n");
		await start();
		await emitInput({ text: "#styled" });
		expect(harness.pi.setModel).toHaveBeenCalled();
	});

	it("refuses a bare model that does not resolve", async () => {
		writeAgent(join(agentDir, "agents"), "styled", "system_prompt: replace\nmodel: bare-model\n");
		await start();
		await emitInput({ text: "#styled" });
		expect(harness.notificationText()).toContain("not available");
	});

	it("drops a baseline tool that no longer resolves on #none with a warning", async () => {
		harness = createHarness({ cwd, activeTools: ["read", "grep", "bash"], allTools: ["read"] });
		mxPiAgents(harness.pi);
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\ntools: [read]\n");
		await start();
		await emitInput({ text: "#style" });
		harness.notifications.length = 0;
		await emitInput({ text: "#none" });
		expect(harness.notificationText()).toContain("no longer resolves");
		expect(harness.activeTools()).toEqual(["read"]);
	});

	it("applies a tool delta on top of the live selection and restores the baseline on #none", async () => {
		harness = createHarness({
			cwd,
			activeTools: ["read", "bash", "edit", "write"],
			allTools: ["read", "bash", "edit", "write", "codemode"],
		});
		mxPiAgents(harness.pi);
		writeAgent(join(agentDir, "agents"), "delta", "system_prompt: replace\ntools: [+codemode, -write]\n");
		await start();
		await emitInput({ text: "#delta" });
		expect(harness.activeTools()).toEqual(["read", "bash", "edit", "codemode"]);

		harness.notifications.length = 0;
		await emitInput({ text: "#none" });
		expect(harness.activeTools()).toEqual(["read", "bash", "edit", "write"]);
	});

	it("refuses a delta that names a tool the session does not have registered", async () => {
		harness = createHarness({ cwd, activeTools: ["read", "bash"], allTools: ["read", "bash"] });
		mxPiAgents(harness.pi);
		writeAgent(join(agentDir, "agents"), "delta", "system_prompt: replace\ntools: [+ghost]\n");
		await start();
		await emitInput({ text: "#delta" });
		expect(harness.notificationText()).toContain("do not resolve");
		expect(harness.activeTools()).toEqual(["read", "bash"]);
	});

	it("status shows the declared entries and the resolved selection", async () => {
		harness = createHarness({ cwd, activeTools: ["read", "bash"], allTools: ["read", "bash", "codemode"] });
		mxPiAgents(harness.pi);
		writeAgent(join(agentDir, "agents"), "delta", "system_prompt: replace\ntools: [+codemode, -bash]\n");
		await start();
		await emitInput({ text: "#delta" });
		const persisted = lastSwitchEntry()?.data as { declared?: string[] } | undefined;
		expect(persisted?.declared).toEqual(["+codemode", "-bash"]);
		harness.notifications.length = 0;
		await harness.runCommand("status");
		expect(harness.notificationText()).toContain("tools: +codemode, -bash → read, codemode");
	});

	it("does nothing when the default persona is empty", async () => {
		await start();
		expect(harness.notificationText()).not.toContain("switched");
	});

	it("re-applies a rehydrated preset model", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		harness = createHarness({
			cwd,
			activeTools: ["read"],
			branch: [
				{
					type: "custom",
					customType: "mx-pi-agents.switch",
					data: {
						name: "style",
						mode: "replace",
						baseline: { tools: ["read"], model: undefined, thinking: "medium" },
						applied: { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
						switchedAt: 1,
					},
				},
			],
		});
		mxPiAgents(harness.pi);
		await start();
		expect(harness.pi.setModel).toHaveBeenCalled();
		expect(harness.currentThinking()).toBe("high");
	});
});

describe("before_agent_start hash verification", () => {
	it("deactivates the switch when the definition changes mid-session", async () => {
		const path = writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		await start();
		await emitInput({ text: "#style" });
		writeFileSync(path, "---\nname: style\ndescription: style description\nsystem_prompt: replace\n---\n\nEVIL\n");

		const options = await emitBeforeAgentStart({ customPrompt: undefined, appendSystemPrompt: "" });
		expect(options.customPrompt).toBeUndefined();
		expect(harness.notificationText()).toContain("main-prompt switch was cancelled");
	});

	it("deactivates the switch when the definition is removed", async () => {
		const path = writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		await start();
		await emitInput({ text: "#style" });
		rmSync(path, { force: true });

		const options = await emitBeforeAgentStart({ customPrompt: undefined, appendSystemPrompt: "" });
		expect(options.customPrompt).toBeUndefined();
		expect(harness.notificationText()).toContain("cancelled");
	});

	it("does nothing when no switch is active", async () => {
		await start();
		const options = await emitBeforeAgentStart({ customPrompt: undefined, appendSystemPrompt: "" });
		expect(options.customPrompt).toBeUndefined();
		expect(options.appendSystemPrompt).toBe("");
	});
});

describe("rehydration", () => {
	it("re-applies a persisted switch on session start", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		harness = createHarness({
			cwd,
			activeTools: ["read", "grep", "bash"],
			branch: [
				{
					type: "custom",
					customType: "mx-pi-agents.switch",
					data: {
						name: "style",
						mode: "replace",
						baseline: { tools: ["read", "grep", "bash"], model: undefined, thinking: "medium" },
						applied: {},
						switchedAt: 1,
					},
				},
			],
		});
		mxPiAgents(harness.pi);
		await start();

		expect(harness.ui.setStatus).toHaveBeenCalledWith("mx-pi-agents", "replace:style");
		const options = await emitBeforeAgentStart({ customPrompt: undefined, appendSystemPrompt: "" });
		expect(options.customPrompt).toBe("Body for style.");
	});

	it("re-applies the preset when the runtime is pristine", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\ntools: [read]\n");
		harness = createHarness({
			cwd,
			activeTools: ["read", "grep", "bash"],
			branch: [
				{
					type: "custom",
					customType: "mx-pi-agents.switch",
					data: {
						name: "style",
						mode: "replace",
						baseline: { tools: ["read", "grep", "bash"], model: undefined, thinking: "medium" },
						applied: { tools: ["read"] },
						switchedAt: 1,
					},
				},
			],
		});
		mxPiAgents(harness.pi);
		await start();
		expect(harness.activeTools()).toEqual(["read"]);
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
			) => Promise<{ items: Array<{ value: string }>; prefix: string }>;
			applyCompletion: (...args: unknown[]) => unknown;
			shouldTriggerFileCompletion: (lines: string[], line: number, col: number) => boolean;
		};
		const current = fakeCurrent();
		return { provider: factory(current), current };
	}

	it("suggests agents at a single-name position with the hash prefix", async () => {
		const { provider } = await providerFor();
		const result = await provider.getSuggestions(["#soc"], 0, 4, { signal: new AbortController().signal });
		expect(result.items.map((item) => item.value)).toContain("#socrates");
		expect(result.prefix).toBe("#soc");
	});

	it("delegates to the built-in provider outside a directive and mirrors applyCompletion", async () => {
		const { provider, current } = await providerFor();
		const result = await provider.getSuggestions(["@src"], 0, 4, { signal: new AbortController().signal });
		expect(current.getSuggestions).toHaveBeenCalled();
		expect(result.items[0].value).toBe("builtin");
		provider.applyCompletion([], 0, 0, {}, "@");
		expect(current.applyCompletion).toHaveBeenCalled();
		expect(provider.shouldTriggerFileCompletion([], 0, 0)).toBe(true);
	});
});

describe("/mx-pi-agents command", () => {
	it("lists the roster for the empty and list commands", async () => {
		await start();
		await harness.runCommand("");
		expect(harness.notificationText()).toContain("socrates");
		harness.notifications.length = 0;
		await harness.runCommand("list");
		expect(harness.notificationText()).toContain("socrates");
	});

	it("status reports config path, counts, agent paths and personas", async () => {
		await start();
		await harness.runCommand("status");
		const text = harness.notificationText();
		expect(text).toContain("config:");
		expect(text).toContain("agents:");
		expect(text).toContain("agentPaths: (none)");
		expect(text).toContain("active persona: (none)");
		expect(text).toContain("default persona: (none)");
	});

	it("status reflects an active switch and the configured default persona", async () => {
		writeAgent(join(agentDir, "agents"), "style", "system_prompt: replace\n");
		await start();
		await emitInput({ text: "#style" });
		setDefaultPersona("socrates");
		harness.notifications.length = 0;
		await harness.runCommand("status");
		const text = harness.notificationText();
		expect(text).toContain("active persona: replace:style");
		expect(text).toContain("default persona: socrates");
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

	it("reports no gated agents and an unknown approve name", async () => {
		await start();
		await harness.runCommand("approve ghost");
		expect(harness.notificationText()).toContain('No gated agent named "ghost"');
		await harness.runCommand("approve");
		expect(harness.notificationText()).toContain("No gated agents to approve.");
	});

	it("records an approved hash in the config file", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, activeTools: ["read"], confirmResult: true });
		mxPiAgents(harness.pi);
		await start();

		await harness.runCommand("approve local");
		const saved = JSON.parse(readFileSync(join(agentDir, "extensions", "mx-pi-agents.json"), "utf8")) as {
			approvals: Record<string, Record<string, { hash: string; kind: string }>>;
		};
		const directories = Object.keys(saved.approvals);
		expect(directories).toHaveLength(1);
		expect(saved.approvals[directories[0]]["local.md"].hash).toMatch(/^[0-9a-f]{64}$/);
		expect(saved.approvals[directories[0]]["local.md"].kind).toBe("project");
		expect(harness.notificationText()).toContain("approved 1 agent(s)");
	});

	it("does not persist an approval the operator declined", async () => {
		writeAgent(join(cwd, ".pi", "agents"), "local");
		harness = createHarness({ cwd, activeTools: ["read"], confirmResult: false });
		mxPiAgents(harness.pi);
		await start();
		await harness.runCommand("approve");
		expect(harness.notificationText()).toContain("no approvals changed");
		expect(existsSync(join(agentDir, "extensions", "mx-pi-agents.json"))).toBe(false);
	});
});

describe("renderers", () => {
	it("renders the roster through the command without leaking control characters", async () => {
		const dir = join(agentDir, "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "evil.md"), '---\nname: evil\ndescription: "a\\u0007b"\n---\n\nBody.\n');
		await start();
		await harness.runCommand("list");
		expect(harness.notificationText()).toContain("evil");
		expect(harness.notificationText()).not.toContain("\u0007");
	});

	it("the mock theme stays usable for direct assertions", () => {
		expect(mockTheme.fg("accent", "x")).toBe("x");
	});
});

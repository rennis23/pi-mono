import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contextStats from "./index.js";
import { createHarness, mockTheme } from "./test/harness.js";

/** Timestamps are fake so tok/s and durations are deterministic. */
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();
let agentDir: string;

function configPath(): string {
	return join(agentDir, "extensions", "mx-pi-settings.json");
}

function readSavedConfig(): Record<string, unknown> {
	if (!existsSync(configPath())) return {};
	const document = JSON.parse(readFileSync(configPath(), "utf8")) as {
		values: Record<string, Record<string, unknown>>;
	};
	return document.values["mx-pi-context-stats"] ?? {};
}

function seedConfig(values: Record<string, unknown>): void {
	mkdirSync(dirname(configPath()), { recursive: true });
	writeFileSync(configPath(), JSON.stringify({ version: 1, values: { "mx-pi-context-stats": values } }), "utf8");
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "mx-pi-cs-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
});

function boot(options: Parameters<typeof createHarness>[0] = {}) {
	const harness = createHarness({ usage: { tokens: 8000, contextWindow: 128_000 }, ...options });
	const registrations: unknown[] = [];
	harness.events.on("mx-pi-settings:register", (payload) => registrations.push(payload));
	contextStats(harness.pi);
	return { ...harness, registrations };
}

/** One assistant turn carrying usage. */
const assistantTurn = {
	role: "assistant",
	usage: { input: 5000, output: 600, cacheRead: 2000, cacheWrite: 0, totalTokens: 15_000, cost: { total: 0.004 } },
};

async function runPrompt(harness: ReturnType<typeof boot>) {
	await harness.emit("agent_start");
	await harness.emit("message_update", { assistantMessageEvent: { type: "text_delta" } });
	vi.advanceTimersByTime(2000); // 600 output tokens over 2s → 300 tok/s
	await harness.emit("message_end", { message: assistantTurn });
	await harness.emit("turn_end", { message: assistantTurn });
	vi.advanceTimersByTime(3000); // total prompt duration 5s
	await harness.emit("agent_end");
}

describe("mx-pi-context-stats extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers its settings with the hub and keeps only the summary command", async () => {
		const harness = boot();
		await harness.emit("session_start");

		expect(harness.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(harness.ui.setWidget.mock.calls[0][0]).toBe("mx-pi-context-stats");
		expect(harness.ui.setWidget.mock.calls[0][2]).toEqual({ placement: "belowEditor" });
		expect(harness.commands.has("mx-pi-context-stats")).toBe(true);
		expect(harness.commands.has("mx-pi-settings")).toBe(false);
		expect(harness.flags.has("mx-pi-context-stats-rows")).toBe(false);
		expect(harness.registrations).toHaveLength(1);
		const registration = harness.registrations[0] as { spec: { id: string; fields: unknown[] } };
		expect(registration.spec.id).toBe("mx-pi-context-stats");
		expect(registration.spec.fields).toEqual([
			{
				key: "visible",
				label: "Widget",
				description: "Show or hide the context stats widget.",
				type: "boolean",
				default: true,
			},
			{
				key: "historyRows",
				label: "History rows",
				description: "Number of completed prompt rows to retain.",
				type: "number",
				default: 5,
				min: 1,
				max: 20,
				integer: true,
			},
			{
				key: "subagentRows",
				label: "Subagent rows",
				description: "Maximum live/completed subagent rows to render.",
				type: "number",
				default: 4,
				min: 0,
				max: 20,
				integer: true,
			},
			{
				key: "showSubagents",
				label: "Subagent section",
				description: "Show tool progress and usage for detected subagents.",
				type: "boolean",
				default: true,
			},
			{
				key: "showHealth",
				label: "Health metrics",
				description: "Show burn rate, projection, and cache ratio.",
				type: "boolean",
				default: true,
			},
			{
				key: "placement",
				label: "Placement",
				description: "Choose where the widget appears relative to the editor.",
				type: "select",
				default: "belowEditor",
				options: [
					{ value: "aboveEditor", label: "Above editor" },
					{ value: "belowEditor", label: "Below editor" },
				],
			},
		]);
	});

	it("wires every lifecycle event it needs", async () => {
		const harness = boot();
		await harness.emit("session_start");
		for (const event of [
			"session_compact",
			"model_select",
			"agent_start",
			"turn_end",
			"message_update",
			"message_end",
			"agent_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]) {
			expect(harness.handlers.has(event), event).toBe(true);
		}
	});

	it("renders a prompt row and publishes live metrics to the footer", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);

		const lines = harness.render(160).join("\n");
		expect(lines).toContain("#1");
		expect(lines).toContain("ctx:8.0k/128k");
		expect(lines).toContain("$0.004");
		expect(lines).toContain("300tok/s");
		expect(lines).toContain("5.0s");
		expect(harness.ui.setStatus.mock.calls.at(-1)).toEqual(["mx-pi-context-stats", "300tok/s  5.0s  ctx:6.3%"]);
	});

	it("loads namespaced options from the central store", async () => {
		seedConfig({ historyRows: 2, visible: false });
		const harness = boot();
		await harness.emit("session_start");
		for (let i = 0; i < 4; i++) await runPrompt(harness);

		expect(harness.render(160)).toEqual([]);
		const registration = harness.registrations[0] as { io: { read(): Record<string, unknown> } };
		expect(registration.io.read()).toMatchObject({ historyRows: 2, visible: false });
	});

	it("applies setting writes from the hub immediately and persists them centrally", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);
		const registration = harness.registrations[0] as {
			io: { write(key: string, value: boolean | number | string): { ok: boolean } };
		};

		expect(harness.render(160).length).toBeGreaterThan(0);
		expect(registration.io.write("visible", false).ok).toBe(true);
		expect(harness.render(160)).toEqual([]);
		expect(registration.io.write("placement", "aboveEditor").ok).toBe(true);
		expect(harness.ui.setWidget.mock.calls.at(-1)?.[2]).toEqual({ placement: "aboveEditor" });
		expect(readSavedConfig()).toMatchObject({ visible: false, placement: "aboveEditor" });
	});

	it("applies run-scoped hub overrides without persisting them", async () => {
		const harness = boot();
		harness.events.emit("mx-pi-settings:configure", {
			protocol: 1,
			assignments: "mx-pi-context-stats.historyRows=2,mx-pi-context-stats.visible=false",
		});
		await harness.emit("session_start");
		for (let i = 0; i < 4; i++) await runPrompt(harness);

		expect(harness.render(160)).toEqual([]);
		expect(readSavedConfig()).toEqual({});
	});

	it("uses the model's context window when pi cannot report usage", async () => {
		const harness = createHarness({ contextWindow: 200_000, usage: undefined });
		contextStats(harness.pi);
		await harness.emit("session_start");
		await runPrompt(harness as ReturnType<typeof boot>);

		expect(harness.render(160).join("\n")).toContain("200k");
	});

	it("adopts a new context window on model_select and survives unknown usage", async () => {
		const harness = createHarness({ contextWindow: 128_000, usage: undefined });
		contextStats(harness.pi);
		await harness.emit("session_start");
		await harness.emit("model_select", { model: { contextWindow: 200_000 } });
		await runPrompt(harness as ReturnType<typeof boot>);
		expect(harness.render(160).join("\n")).toContain("200k");
	});

	it("clears stale status and restarts the clock after a user turn", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);
		await harness.emit("session_start");
		expect(harness.ui.setStatus.mock.calls.at(-1)?.[1]).toBeUndefined();
		expect(harness.render(160)).toEqual([]);

		await harness.emit("agent_start");
		vi.advanceTimersByTime(10_000);
		await harness.emit("turn_end", { message: { role: "user" } });
		vi.advanceTimersByTime(1000);
		await harness.emit("agent_end");
		expect(harness.render(160).join("\n")).toContain("1.0s");
	});

	it("marks the snapshot after a compaction and bounds rolling history", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.emit("session_compact");
		await runPrompt(harness);
		expect(harness.render(160).join("\n")).toContain("⟳");
		for (let i = 0; i < 5; i++) await runPrompt(harness);
		const text = harness.render(160).join("\n");
		expect(text).toContain("#6");
		expect(text).not.toContain("#1  ");
	});
});

describe("mx-pi-context-stats command and subagent tracking", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows session summaries and rejects settings-like subcommands", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.runCommand("");
		expect(harness.ui.notify.mock.calls.at(-1)?.[0]).toBe("mx-pi-context-stats: nothing tracked yet");
		await runPrompt(harness);
		await harness.runCommand("summary");
		expect(harness.ui.notify.mock.calls.at(-1)?.[0]).toContain("1 prompt(s) tracked");
		await harness.runCommand("rows 5");
		expect(harness.ui.notify.mock.calls.at(-1)).toEqual(["Usage: /mx-pi-context-stats [summary]", "warning"]);
	});

	it("tracks a spawn_subagent tool call end to end", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.emit("agent_start");
		await harness.emit("tool_execution_start", {
			toolName: "spawn_subagent",
			toolCallId: "call-1",
			args: { agent_name: "Explore", tools: ["read", "grep"] },
		});
		await harness.emit("tool_execution_update", {
			toolName: "spawn_subagent",
			toolCallId: "call-1",
			partialResult: { details: { usage: { turns: 2, input: 8000, output: 1000 } } },
		});
		vi.advanceTimersByTime(4000);
		await harness.emit("tool_execution_end", {
			toolName: "spawn_subagent",
			toolCallId: "call-1",
			isError: false,
			result: {
				details: {
					usage: { turns: 3, input: 15_000, output: 2000, totalTokens: 18_000, cost: 0.005 },
					model: "anthropic/claude-sonnet-4-5",
					toolsUsed: ["read", "grep"],
				},
			},
		});
		const text = harness.render(160).join("\n");
		expect(text).toContain("subagents");
		expect(text).toContain("✓");
		expect(text).toContain("Explore");
		expect(text).toContain("sonnet-4-5");
		expect(text).toContain("18.0k");
		expect(text).toContain("500tok/s");
	});

	it("ignores non-subagent tools and shows no empty subagent section", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.emit("tool_execution_start", { toolName: "bash", toolCallId: "x", args: {} });
		await harness.emit("tool_execution_update", { toolName: "bash", toolCallId: "x", partialResult: {} });
		await harness.emit("tool_execution_end", { toolName: "bash", toolCallId: "x", isError: false, result: {} });
		expect(harness.render(160)).toEqual([]);
	});

	it("renders a safe error line when the theme fails and tolerates narrow widths", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);
		const factory = harness.widgetFactory();
		const broken = {
			fg: () => {
				throw new Error("theme boom");
			},
		};
		const component = factory?.({ requestRender: vi.fn() }, broken);
		expect(component?.render(80)).toEqual(["mx-pi-context-stats widget: theme boom"]);
		for (const width of [0, 1, 20, 80, 200]) expect(() => harness.render(width)).not.toThrow();
	});

	it("does not let stale TUI redraw handles break lifecycle handlers", async () => {
		const harness = boot();
		await harness.emit("session_start");
		const factory = harness.widgetFactory();
		factory?.(
			{
				requestRender() {
					throw new Error("stale TUI");
				},
			},
			mockTheme,
		);
		await expect(harness.emit("agent_end")).resolves.toBeUndefined();
	});

	it("uses a plain-text theme without leaking ANSI", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);
		for (const line of harness.render(160)) expect(line).not.toContain("\u001b");
		expect(mockTheme.fg("accent", "x")).toBe("x");
	});
});

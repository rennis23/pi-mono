import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contextStats from "./index.js";
import { createHarness, mockTheme } from "./test/harness.js";

/** Timestamps are fake so tok/s and durations are deterministic. */
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

/**
 * Every test gets a throwaway PI_CODING_AGENT_DIR so config reads/writes land
 * in a temp folder instead of the real ~/.pi/agent/extensions.
 */
let agentDir: string;

function configPath(): string {
	return join(agentDir, "extensions", "mx-pi-context-stats.json");
}

function readSavedConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(configPath(), "utf8"));
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
	contextStats(harness.pi);
	return harness;
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

	it("registers the widget below the editor and the /mx-pi-settings command", async () => {
		const harness = boot();
		await harness.emit("session_start");

		expect(harness.ui.setWidget).toHaveBeenCalledTimes(1);
		const [key, , opts] = harness.ui.setWidget.mock.calls[0];
		expect(key).toBe("mx-pi-context-stats");
		expect(opts).toEqual({ placement: "belowEditor" });
		expect(harness.commands.has("mx-pi-settings")).toBe(true);
		expect(harness.commands.has("mx-pi-context-stats")).toBe(false);
		expect(harness.flags.has("mx-pi-context-stats-rows")).toBe(true);
		expect(harness.flags.has("mx-pi-context-stats-hide")).toBe(true);
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

	it("renders a prompt row after a completed prompt", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);

		const lines = harness.render(160);
		expect(lines.join("\n")).toContain("#1");
		expect(lines.join("\n")).toContain("ctx:8.0k/128k");
		expect(lines.join("\n")).toContain("$0.004");
		expect(lines.join("\n")).toContain("300tok/s");
		expect(lines.join("\n")).toContain("5.0s");
	});

	it("publishes tok/s, duration and context to the footer status row", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);

		const status = harness.ui.setStatus.mock.calls.at(-1);
		expect(status?.[0]).toBe("mx-pi-context-stats");
		expect(status?.[1]).toBe("300tok/s  5.0s  ctx:6.3%");
	});

	it("clears the status row on a new session", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);
		await harness.emit("session_start");

		expect(harness.ui.setStatus.mock.calls.at(-1)?.[1]).toBeUndefined();
		expect(harness.render(160)).toEqual([]);
	});

	it("keeps a rolling history bounded by historyRows", async () => {
		const harness = boot();
		await harness.emit("session_start");
		for (let i = 0; i < 6; i++) await runPrompt(harness);

		const text = harness.render(160).join("\n");
		// historyRows default is 5, so only #2..#6 survive.
		expect(text).toContain("#6");
		expect(text).not.toContain("#1  ");
	});

	it("uses the model's context window when pi cannot report usage", async () => {
		const harness = createHarness({ contextWindow: 200_000, usage: undefined });
		contextStats(harness.pi);
		await harness.emit("session_start");
		await runPrompt(harness);

		expect(harness.render(160).join("\n")).toContain("200k");
	});

	it("adopts a new context window on model_select", async () => {
		const harness = createHarness({ contextWindow: 128_000, usage: undefined });
		contextStats(harness.pi);
		await harness.emit("session_start");
		await harness.emit("model_select", { model: { contextWindow: 200_000 } });
		await runPrompt(harness);

		expect(harness.render(160).join("\n")).toContain("200k");
	});

	it("survives unknown context usage", async () => {
		const harness = createHarness({ usage: undefined });
		contextStats(harness.pi);
		await harness.emit("session_start");

		await expect(runPrompt(harness)).resolves.toBeUndefined();
		// Unknown usage is rendered as 0 rather than NaN, and the run completes.
		expect(harness.render(160).join("\n")).toContain("0.0%");
	});

	it("restarts the clock when a user turn ends", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.emit("agent_start");
		vi.advanceTimersByTime(10_000);
		await harness.emit("turn_end", { message: { role: "user" } });
		vi.advanceTimersByTime(1000);
		await harness.emit("agent_end");

		expect(harness.render(160).join("\n")).toContain("1.0s");
	});

	it("marks the snapshot after a compaction", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.emit("session_compact");
		await runPrompt(harness);

		expect(harness.render(160).join("\n")).toContain("⟳");
	});
});

describe("subagent tracking", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
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
		expect(text).toContain("500tok/s"); // 2000 output tokens over 4s
	});

	it("ignores tools that are not subagent spawners", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.emit("tool_execution_start", { toolName: "bash", toolCallId: "x", args: {} });
		await harness.emit("tool_execution_update", { toolName: "bash", toolCallId: "x", partialResult: {} });
		await harness.emit("tool_execution_end", { toolName: "bash", toolCallId: "x", isError: false, result: {} });

		expect(harness.render(160)).toEqual([]);
	});

	it("shows nothing at all when no subagent tool is ever used", async () => {
		const harness = boot();
		await harness.emit("session_start");
		expect(harness.render(160)).toEqual([]);
	});
});

describe("/mx-pi-settings command", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("toggles the widget and persists visibility", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);
		expect(harness.render(160).length).toBeGreaterThan(0);

		await harness.runCommand("toggle");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings widget hidden", "info");
		expect(harness.render(160)).toEqual([]);
		expect(readSavedConfig().visible).toBe(false);

		await harness.runCommand("toggle");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings widget shown", "info");
		expect(harness.render(160).length).toBeGreaterThan(0);
		expect(readSavedConfig().visible).toBe(true);
	});

	it("applies rows immediately without waiting for the next prompt", async () => {
		const harness = boot();
		await harness.emit("session_start");
		for (let i = 0; i < 5; i++) await runPrompt(harness);

		await harness.runCommand("rows 2");
		const text = harness.render(160).join("\n");
		expect(text).toContain("#5");
		expect(text).toContain("#4");
		expect(text).not.toContain("#3  ");
	});

	it("reports and sets history rows", async () => {
		const harness = boot();
		await harness.emit("session_start");

		await harness.runCommand("rows");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings rows: 5", "info");

		await harness.runCommand("rows 8");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings rows: 8", "info");

		await harness.runCommand("rows 999");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings rows: 20", "info");

		await harness.runCommand("rows abc");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings rows: 20", "info");

		expect(readSavedConfig().historyRows).toBe(20);
	});

	it("reports and sets subagent rows", async () => {
		const harness = boot();
		await harness.emit("session_start");

		await harness.runCommand("subagent-rows");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings subagent-rows: 4", "info");

		await harness.runCommand("subagent-rows 2");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings subagent-rows: 2", "info");
		expect(readSavedConfig().subagentRows).toBe(2);
	});

	it("toggles sections and rejects bad values", async () => {
		const harness = boot();
		await harness.emit("session_start");

		await harness.runCommand("subagents off");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings subagents: off", "info");
		expect(readSavedConfig().showSubagents).toBe(false);

		await harness.runCommand("subagents maybe");
		const warning = harness.ui.notify.mock.calls.at(-1);
		expect(warning?.[1]).toBe("warning");

		await harness.runCommand("health off");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings health: off", "info");
		expect(readSavedConfig().showHealth).toBe(false);
	});

	it("moves the widget, re-registers it and persists the placement", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.runCommand("placement above");

		expect(harness.ui.setWidget).toHaveBeenCalledTimes(2);
		expect(harness.ui.setWidget.mock.calls.at(-1)?.[2]).toEqual({ placement: "aboveEditor" });
		expect(readSavedConfig().placement).toBe("aboveEditor");

		await harness.runCommand("placement sideways");
		expect(harness.ui.notify.mock.calls.at(-1)?.[1]).toBe("warning");
	});

	it("prints a summary and clears history", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);

		await harness.runCommand("summary");
		expect(harness.ui.notify.mock.calls.at(-1)?.[0]).toContain("1 prompt(s) tracked");

		await harness.runCommand("reset");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings history cleared", "info");
		expect(harness.render(160)).toEqual([]);
	});

	it("warns on unknown arguments", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await harness.runCommand("nonsense");

		const [message, level] = harness.ui.notify.mock.calls.at(-1) ?? [];
		expect(level).toBe("warning");
		expect(message).toContain("Unknown mx-pi-settings argument: nonsense");
	});
});

describe("/mx-pi-settings interactive picker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens the picker on bare /mx-pi-settings and applies the chosen action", async () => {
		const harness = boot();
		await harness.emit("session_start");

		harness.ui.select.mockResolvedValueOnce("Widget — shown");
		await harness.runCommand("");

		expect(harness.ui.select).toHaveBeenCalledWith(
			"mx-pi-settings (mx-pi-context-stats)",
			expect.arrayContaining(["Widget — shown", "History rows — 5", "Placement — below editor"]),
		);
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings widget hidden", "info");
		expect(readSavedConfig().visible).toBe(false);
	});

	it("asks for a number when editing a numeric option", async () => {
		const harness = boot();
		await harness.emit("session_start");

		harness.ui.select.mockResolvedValueOnce("History rows — 5");
		harness.ui.input.mockResolvedValueOnce("7");
		await harness.runCommand("");

		expect(harness.ui.input).toHaveBeenCalledWith("History rows", "1-20: 5");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings historyRows: 7", "info");
		expect(readSavedConfig().historyRows).toBe(7);
	});

	it("changes nothing when the picker is dismissed", async () => {
		const harness = boot();
		await harness.emit("session_start");

		// Default harness dialogs resolve to undefined (Esc).
		await harness.runCommand("");

		expect(harness.ui.notify).not.toHaveBeenCalled();
		expect(existsSync(configPath())).toBe(false);
	});

	it("reports values without a dialog when UI is unavailable", async () => {
		const harness = boot({ hasUI: false });
		await harness.emit("session_start");

		await harness.runCommand("");

		expect(harness.ui.select).not.toHaveBeenCalled();
		const [message] = harness.ui.notify.mock.calls.at(-1) ?? [];
		expect(message).toContain("historyRows=5");
		expect(message).toContain("placement=belowEditor");
	});
});

describe("config file", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("loads options from the config file on session_start", async () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), JSON.stringify({ historyRows: 9, visible: false }), "utf8");

		const harness = boot();
		await harness.emit("session_start");

		await harness.runCommand("rows");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings rows: 9", "info");

		await runPrompt(harness);
		expect(harness.render(160)).toEqual([]);
	});

	it("CLI flags override the config file for one run without persisting", async () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), JSON.stringify({ historyRows: 9 }), "utf8");

		const harness = boot();
		harness.flagValues.set("mx-pi-context-stats-rows", "2");
		await harness.emit("session_start");

		await harness.runCommand("rows");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings rows: 2", "info");
		expect(readSavedConfig().historyRows).toBe(9);
	});

	it("still applies the change when the config cannot be saved", async () => {
		// A regular file where the extensions directory should be makes save fail.
		writeFileSync(join(agentDir, "extensions"), "not a directory", "utf8");

		const harness = boot();
		await harness.emit("session_start");
		await harness.runCommand("rows 8");

		const saveWarning = harness.ui.notify.mock.calls.find((m) => String(m[0]).includes("could not save config"));
		expect(saveWarning?.[1]).toBe("warning");

		await harness.runCommand("rows");
		expect(harness.ui.notify).toHaveBeenLastCalledWith("mx-pi-settings rows: 8", "info");
	});
});

describe("widget robustness", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders an error line instead of throwing when the theme fails", async () => {
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
	});

	it("honours the mx-pi-context-stats-hide flag", async () => {
		const harness = boot();
		harness.flagValues.set("mx-pi-context-stats-hide", true);
		await harness.emit("session_start");
		await runPrompt(harness);

		expect(harness.render(160)).toEqual([]);
	});

	it("honours the mx-pi-context-stats-rows flag", async () => {
		const harness = boot();
		harness.flagValues.set("mx-pi-context-stats-rows", "2");
		await harness.emit("session_start");
		for (let i = 0; i < 4; i++) await runPrompt(harness);

		const text = harness.render(160).join("\n");
		expect(text).toContain("#4");
		expect(text).not.toContain("#2  ");
	});

	it("renders at any width without throwing", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);
		await harness.emit("tool_execution_start", {
			toolName: "spawn_subagent",
			toolCallId: "call-1",
			args: { agent_name: "Explore" },
		});

		for (const width of [0, 1, 20, 80, 200]) {
			expect(() => harness.render(width)).not.toThrow();
		}
	});

	it("uses a plain-text theme without leaking ANSI", async () => {
		const harness = boot();
		await harness.emit("session_start");
		await runPrompt(harness);
		for (const line of harness.render(160)) {
			expect(line).not.toContain("\u001b");
		}
		expect(mockTheme.fg("accent", "x")).toBe("x");
	});
});

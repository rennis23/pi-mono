/**
 * Control-flow tests for the in-process runner's run loop.
 *
 * These drive `runInProcess` through the runner's `createSession` seam with a
 * fake session, so event handling, budgets, abort wiring and result shaping are
 * covered without a model call (the parent SDK integration suite covers the
 * real-session resource-loading invariants).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunPlan } from "../types.js";
import { createInProcessRunner } from "./in-process.js";

let root: string;
let agentDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mx-pi-agents-run-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
	return {
		agentName: "tester",
		source: { kind: "global", path: join(agentDir, "tester.md"), directory: agentDir, trusted: true },
		task: "do the thing",
		tools: ["read"],
		noTools: undefined,
		model: undefined,
		thinking: undefined,
		systemPrompt: "You are a tester.",
		budgets: { maxTurns: 5, timeoutMs: 10_000, tokenBudget: 1_000, costBudget: undefined },
		isolation: "process",
		sandbox: "none",
		cwd: root,
		scope: { roots: [root], unrestricted: false },
		diagnostics: [],
		...overrides,
	};
}

interface FakeScript {
	messages?: Array<Record<string, unknown>>;
}

function fakeSession(script: FakeScript) {
	const listeners: Array<(event: unknown) => void> = [];
	const abort = vi.fn();
	const dispose = vi.fn();
	const session = {
		subscribe: (fn: (event: unknown) => void) => {
			listeners.push(fn);
			return () => {};
		},
		prompt: async () => {
			for (const message of script.messages ?? []) {
				for (const listener of listeners) listener({ type: "message_end", message });
			}
			for (const listener of listeners) listener({ type: "turn_end" });
		},
		agent: { waitForIdle: async () => {} },
		abort,
		dispose,
	};
	return { session, abort, dispose };
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, cost: { total: 0.25 } },
		stopReason: "end",
		...overrides,
	};
}

function runnerWith(fake: ReturnType<typeof fakeSession>, sandboxAvailable = true) {
	return createInProcessRunner({
		agentDir,
		isSandboxAvailable: () => sandboxAvailable,
		createSession: (async () => ({ session: fake.session })) as never,
	});
}

describe("in-process run loop", () => {
	it("returns assistant text and usage on success", async () => {
		const fake = fakeSession({ messages: [assistantMessage()] });
		const result = await runnerWith(fake).run(plan(), { signal: new AbortController().signal, now: () => 0 });
		expect(result.ok).toBe(true);
		expect(result.text).toBe("hello");
		expect(result.turns).toBe(1);
		expect(result.usage).toMatchObject({
			input: 10,
			output: 5,
			cacheRead: 1,
			cacheWrite: 2,
			cost: 0.25,
			contextTokens: 18,
		});
		expect(fake.dispose).toHaveBeenCalled();
	});

	it("extracts a string content body and ignores non-text parts", async () => {
		const fake = fakeSession({ messages: [assistantMessage({ content: "plain string" })] });
		const result = await runnerWith(fake).run(plan(), { signal: new AbortController().signal, now: () => 0 });
		expect(result.text).toBe("plain string");

		const mixed = fakeSession({
			messages: [
				assistantMessage({
					content: [
						{ type: "tool", text: "x" },
						{ type: "text", text: "kept" },
					],
				}),
			],
		});
		const mixedResult = await runnerWith(mixed).run(plan(), { signal: new AbortController().signal, now: () => 0 });
		expect(mixedResult.text).toBe("kept");
	});

	it("tolerates a missing usage block and a numeric cost", async () => {
		const noUsage = fakeSession({ messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }] });
		const first = await runnerWith(noUsage).run(plan(), { signal: new AbortController().signal, now: () => 0 });
		expect(first.usage.input).toBe(0);

		const numericCost = fakeSession({
			messages: [assistantMessage({ usage: { input: 1, cost: 0.5 } })],
		});
		const second = await runnerWith(numericCost).run(plan(), { signal: new AbortController().signal, now: () => 0 });
		expect(second.usage.cost).toBe(0.5);
	});

	it("does not start a session for an already-aborted signal", async () => {
		const createSession = vi.fn();
		const runner = createInProcessRunner({ agentDir, createSession: createSession as never });
		const controller = new AbortController();
		controller.abort();
		const result = await runner.run(plan(), { signal: controller.signal, now: () => 0 });
		expect(result.stopped).toBe("aborted");
		expect(createSession).not.toHaveBeenCalled();
	});

	it("stops on a turn-budget breach and aborts the session", async () => {
		const fake = fakeSession({ messages: [assistantMessage()] });
		const result = await runnerWith(fake).run(
			plan({ budgets: { maxTurns: 0, timeoutMs: 10_000, tokenBudget: 1_000, costBudget: undefined } }),
			{ signal: new AbortController().signal, now: () => 0 },
		);
		expect(result.stopped).toBe("budget-turns");
		expect(result.ok).toBe(false);
		expect(fake.abort).toHaveBeenCalled();
	});

	it("stops on a token-budget breach", async () => {
		const fake = fakeSession({ messages: [assistantMessage()] });
		const result = await runnerWith(fake).run(
			plan({ budgets: { maxTurns: 5, timeoutMs: 10_000, tokenBudget: 1, costBudget: undefined } }),
			{ signal: new AbortController().signal, now: () => 0 },
		);
		expect(result.stopped).toBe("budget-tokens");
	});

	it("stops on a cost-budget breach", async () => {
		const fake = fakeSession({ messages: [assistantMessage()] });
		const result = await runnerWith(fake).run(
			plan({ budgets: { maxTurns: 5, timeoutMs: 10_000, tokenBudget: 1_000, costBudget: 0.1 } }),
			{ signal: new AbortController().signal, now: () => 0 },
		);
		expect(result.stopped).toBe("budget-cost");
	});

	it("records an error message from the assistant", async () => {
		const fake = fakeSession({ messages: [assistantMessage({ errorMessage: "boom", content: [] })] });
		const result = await runnerWith(fake).run(plan(), { signal: new AbortController().signal, now: () => 0 });
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toBe("boom");
	});

	it("refuses sandbox: os when no backend is available", async () => {
		const fake = fakeSession({});
		const createSession = vi.fn();
		const runner = createInProcessRunner({
			agentDir,
			isSandboxAvailable: () => false,
			createSession: createSession as never,
		});
		const result = await runner.run(plan({ sandbox: "os", tools: ["bash"] }), {
			signal: new AbortController().signal,
			now: () => 0,
		});
		expect(result.stopped).toBe("child-error");
		expect(result.errorMessage).toContain("sandbox: os requested");
		expect(createSession).not.toHaveBeenCalled();
		expect(fake.abort).not.toHaveBeenCalled();
	});

	it("reports partial and settled progress through onUpdate", async () => {
		const fake = fakeSession({ messages: [assistantMessage()] });
		const updates: boolean[] = [];
		await runnerWith(fake).run(plan(), {
			signal: new AbortController().signal,
			now: () => 0,
			onUpdate: (partial) => updates.push(partial.partial),
		});
		expect(updates).toContain(false);
		expect(updates).toContain(true);
	});

	it("ignores non-assistant message events", async () => {
		const fake = fakeSession({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
		const result = await runnerWith(fake).run(plan(), { signal: new AbortController().signal, now: () => 0 });
		expect(result.turns).toBe(0);
		expect(result.ok).toBe(true);
	});
});

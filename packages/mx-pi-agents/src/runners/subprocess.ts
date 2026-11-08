/**
 * Subprocess runner: spawn a `pi` child with a hardened argv.
 *
 * Invariants enforced here (design §5.2 and §8):
 * - the task is written to **stdin**, never argv (invariant 5), so it cannot be
 *   read out of `ps` and cannot hit an argv length limit;
 * - the system prompt lives in a `0700` temp dir as a `0600` file, and only its
 *   path appears in argv; the dir is removed in `finally`;
 * - the child gets `--no-*` flags for every discovery source, so project
 *   settings, skills, context files and extensions are all off;
 * - `MX_PI_AGENTS_CHILD=1` is set so the extension refuses to run inside a
 *   child even if it were somehow loaded;
 * - abort kills the whole process group (SIGTERM, then SIGKILL).
 *
 * Nothing is written under the child's working directory: the only temp
 * artifacts are under `os.tmpdir()`.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetTracker, budgetStopReason } from "../budget.js";
import { safeTempName } from "../security.js";
import type { Runner, RunOptions, RunPlan, RunResult, TokenUsage } from "../types.js";
import { isSandboxAvailable, sandboxUnavailableReason, shellQuote } from "./sandbox.js";

/** Environment marker that makes the extension refuse inside a child. */
export const CHILD_ENV_MARKER = "MX_PI_AGENTS_CHILD";

/** Cap on accumulated stderr, to keep a chatty child from exhausting memory. */
export const MAX_STDERR_BYTES = 8 * 1024;
/** Cap on a single JSONL line from the child. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL when aborting. */
export const KILL_GRACE_MS = 5_000;

export interface SubprocessRunnerDeps {
	/** The pi executable invocation: command plus any prefix args. */
	resolvePi: () => { command: string; args: string[] };
	/** Extra environment for the child. */
	env?: NodeJS.ProcessEnv;
	/** Platform override for sandbox probing (tests). */
	platform?: NodeJS.Platform;
	/** Sandbox availability override (tests). */
	isSandboxAvailable?: () => boolean;
}

/**
 * Build the child argv. Pure and golden-tested: the task never appears here,
 * and every discovery source is disabled.
 */
export function buildChildArgv(plan: RunPlan, systemPromptPath: string): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-approve",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
	];
	if (plan.noTools === "all") args.push("--no-tools");
	else args.push("--tools", plan.tools.join(","));
	if (plan.model !== undefined) args.push("--model", plan.model);
	if (plan.thinking !== undefined) args.push("--thinking", plan.thinking);
	args.push("--append-system-prompt", systemPromptPath);
	return args;
}

/** Write the system prompt to a 0600 file inside a fresh 0700 temp dir. */
export function writeSystemPromptFile(agentName: string, systemPrompt: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), `mx-pi-agents-${safeTempName(agentName)}-`));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, "system-prompt.md");
	writeFileSync(path, systemPrompt, { encoding: "utf8", mode: 0o600 });
	return { dir, path };
}

/** Parse one JSONL line into an event, or undefined when it is not JSON. */
export function parseChildLine(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Accumulate usage from a child `message_end` event. */
export function readChildUsage(event: Record<string, unknown>): Partial<TokenUsage> {
	const message = event.message as Record<string, unknown> | undefined;
	if (message?.role !== "assistant") return {};
	const usage = message.usage as Record<string, unknown> | undefined;
	if (!usage) return {};
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const cost = usage.cost as { total?: unknown } | undefined;
	return {
		input: num(usage.input),
		output: num(usage.output),
		cacheRead: num(usage.cacheRead),
		cacheWrite: num(usage.cacheWrite),
		cost: cost && typeof cost === "object" ? num(cost.total) : num(usage.cost),
		contextTokens: num(usage.totalTokens),
	};
}

/** Extract assistant text from a child `message_end` event. */
export function readChildText(event: Record<string, unknown>): string {
	const message = event.message as { role?: string; content?: unknown } | undefined;
	if (message?.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part !== null && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

export function createSubprocessRunner(deps: SubprocessRunnerDeps): Runner {
	return {
		kind: "subprocess",
		async run(plan: RunPlan, options: RunOptions): Promise<RunResult> {
			return runSubprocess(plan, options, deps);
		},
	};
}

async function runSubprocess(plan: RunPlan, options: RunOptions, deps: SubprocessRunnerDeps): Promise<RunResult> {
	const startedAt = options.now();
	const tracker = new BudgetTracker(plan.budgets, options.now);
	const diagnostics = [...plan.diagnostics];
	const platform = deps.platform ?? process.platform;
	const sandboxProbe = deps.isSandboxAvailable ?? (() => isSandboxAvailable(platform));

	// An already-aborted signal must not spawn anything.
	if (options.signal.aborted) {
		return {
			agent: plan.agentName,
			ok: false,
			partial: false,
			stopped: "aborted",
			text: "",
			truncated: false,
			durationMs: 0,
			turns: 0,
			usage: tracker.usage,
			stopReason: undefined,
			errorMessage: undefined,
			diagnostics,
		};
	}

	if (plan.sandbox === "os" && !sandboxProbe()) {
		return {
			agent: plan.agentName,
			ok: false,
			partial: false,
			stopped: "child-error",
			text: "",
			truncated: false,
			durationMs: 0,
			turns: 0,
			usage: tracker.usage,
			stopReason: undefined,
			errorMessage: `sandbox: os requested but ${sandboxUnavailableReason(platform)}`,
			diagnostics,
		};
	}

	const { dir, path } = writeSystemPromptFile(plan.agentName, plan.systemPrompt);
	let text = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let stopped: RunResult["stopped"];
	let aborted = false;
	let exitCode: number | null = null;
	let stderr = "";
	let buffer = "";
	let child: ReturnType<typeof spawn> | undefined;
	let killTimer: NodeJS.Timeout | undefined;

	const emit = () => {
		options.onUpdate?.({
			agent: plan.agentName,
			ok: errorMessage === undefined && stopped === undefined,
			partial: stopped !== undefined,
			stopped,
			text,
			truncated: false,
			durationMs: options.now() - startedAt,
			turns: tracker.turns,
			usage: tracker.usage,
			stopReason,
			errorMessage,
			diagnostics,
		});
	};

	const killGroup = (signal: NodeJS.Signals) => {
		const pid = child?.pid;
		if (pid === undefined) return;
		try {
			// Negative pid targets the whole process group.
			process.kill(-pid, signal);
		} catch {
			try {
				child?.kill(signal);
			} catch {
				/* already gone */
			}
		}
	};

	const abortListener = () => {
		aborted = true;
		killGroup("SIGTERM");
		killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
		killTimer.unref?.();
	};
	options.signal.addEventListener("abort", abortListener, { once: true });

	const handleLine = (line: string) => {
		const event = parseChildLine(line);
		if (!event) return;
		const type = event.type;
		if (type === "message_end") {
			tracker.noteTurn();
			tracker.noteUsage(readChildUsage(event));
			const message = event.message as { stopReason?: unknown; errorMessage?: unknown } | undefined;
			if (typeof message?.stopReason === "string") stopReason = message.stopReason;
			if (typeof message?.errorMessage === "string") errorMessage = message.errorMessage;
			const next = readChildText(event);
			if (next.length > 0) text = next;
			emit();
		} else if (type === "tool_result_end") {
			emit();
		}

		if (stopped === undefined && !aborted) {
			const breach = tracker.check();
			if (breach) {
				stopped = budgetStopReason(breach.kind);
				diagnostics.push({ level: "warning", message: breach.message });
				killGroup("SIGTERM");
			}
		}
	};

	try {
		const invocation = deps.resolvePi();
		const argv = [...invocation.args, ...buildChildArgv(plan, path)];
		// Sandboxing of the child's *bash tool* happens inside the child (the
		// in-process runner path); the subprocess itself is sandboxed only when a
		// future profile adds it. `detectBackend` is checked in `runSubprocess`
		// before we get here, so availability is already proven.
		child = spawn(invocation.command, argv, {
			cwd: plan.cwd,
			shell: false,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				...(deps.env ?? {}),
				// Defense in depth: the extension refuses inside a marked child.
				[CHILD_ENV_MARKER]: "1",
			},
		});

		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES * 4) {
				// A pathological stream: keep the tail rather than growing forever.
				buffer = buffer.slice(-MAX_LINE_BYTES);
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
				stderr = stderr.slice(-MAX_STDERR_BYTES);
			}
		});

		// The task goes over stdin, never argv.
		child.stdin?.end(plan.task);

		exitCode = await new Promise<number | null>((resolve) => {
			child?.on("close", (code) => resolve(code));
			child?.on("error", (err) => {
				if (!errorMessage) errorMessage = err.message;
				resolve(null);
			});
		});

		if (buffer.trim().length > 0) handleLine(buffer);
	} catch (err) {
		if (!errorMessage) errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		options.signal.removeEventListener("abort", abortListener);
		if (killTimer) clearTimeout(killTimer);
		// The temp dir is removed unconditionally: nothing survives the run.
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}

	if (aborted && stopped === undefined) stopped = "aborted";
	if (stopped === undefined && !aborted) {
		const breach = tracker.check();
		if (breach) {
			stopped = budgetStopReason(breach.kind);
			diagnostics.push({ level: "warning", message: breach.message });
		}
	}
	if (errorMessage === undefined && stopped === undefined && exitCode !== 0 && exitCode !== null) {
		errorMessage = stderr.trim().length > 0 ? stderr.trim() : `child exited with code ${exitCode}`;
	}

	return {
		agent: plan.agentName,
		ok: errorMessage === undefined && stopped === undefined,
		partial: stopped !== undefined || (errorMessage !== undefined && text.length > 0),
		stopped,
		text,
		truncated: false,
		durationMs: options.now() - startedAt,
		turns: tracker.turns,
		usage: tracker.usage,
		stopReason,
		errorMessage,
		diagnostics,
	};
}

/** Shell-quoted description of the child command, for diagnostics only. */
export function describeChildCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map(shellQuote).join(" ");
}

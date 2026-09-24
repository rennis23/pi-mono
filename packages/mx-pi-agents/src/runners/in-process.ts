/**
 * In-process runner: one `AgentSession` per run, in the current process.
 *
 * Security properties are structural here, not policy:
 * - settings are built in memory from **global** values only, so there is no
 *   code path that reads `<target>/.pi/settings.json` (no attacker-controlled
 *   `shellCommandPrefix`/`shellPath`);
 * - the session is in-memory, so nothing is written to disk;
 * - the resource loader disables extensions, skills, prompt templates, themes
 *   and context files, so a hostile `.pi/skills/**` cannot reach the child's
 *   system prompt;
 * - the child has no extensions loaded, so `mx_pi_agent` cannot exist inside it;
 * - tools are the computed grant set, or `noTools: "all"` when it is empty.
 *
 * This module is the only place pi SDK session creation is reachable, which is
 * what makes invariant 1 of the design testable by inspection.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createBashToolDefinition,
	createLocalBashOperations,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BudgetTracker, budgetStopReason } from "../budget.js";
import type { Runner, RunOptions, RunPlan, RunResult, TokenUsage } from "../types.js";
import { zeroUsage } from "../types.js";
import { createSandboxedBashOperations, isSandboxAvailable, sandboxUnavailableReason } from "./sandbox.js";

/** Names of the built-in tools the child can be granted. */
export const BUILTIN_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Settings keys that must never be inherited from a project scope. */
export const PROJECT_SCOPED_SETTINGS_KEYS: readonly string[] = [
	"shellCommandPrefix",
	"shellPath",
	"packages",
	"extensions",
	"skills",
	"prompts",
	"themes",
];

export interface InProcessRunnerDeps {
	/** Global agent dir (auth, models, global settings). */
	agentDir: string;
	/** Parent runtime, reused so provider auth/headers match the parent. */
	modelRuntime?: ModelRuntime;
	/** Resolve a model label like `anthropic/claude-sonnet-4-5`. */
	resolveModel?: (label: string) => { provider: string; modelId: string } | undefined;
	/** Override the sandbox availability probe (tests). */
	isSandboxAvailable?: () => boolean;
}

/** Extract assistant text from a message content array. */
function extractText(content: unknown): string {
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

/** Read token usage off an assistant message, tolerating missing fields. */
function readUsage(message: unknown): Partial<TokenUsage> {
	const usage = (message as { usage?: Record<string, unknown> } | undefined)?.usage;
	if (usage === undefined || usage === null) return {};
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

/**
 * Build a global-only settings manager.
 *
 * `SettingsManager.create(cwd, agentDir)` is deliberately not used: its project
 * scope is derived from the cwd argument, so any cwd could pick up a
 * `<cwd>/.pi/settings.json` — the piolium P-01 vector (`shellCommandPrefix`,
 * `shellPath`). Reading `<agentDir>/settings.json` directly means there is no
 * code path that can observe a project settings file, regardless of cwd.
 */
export function createChildSettingsManager(agentDir: string): SettingsManager {
	// An empty dir would make `join(agentDir, "settings.json")` resolve against
	// `process.cwd()` — which is the target repository. Refuse instead of
	// silently reading attacker-controlled settings.
	if (agentDir.trim().length === 0) {
		throw new Error("createChildSettingsManager requires a non-empty agentDir");
	}

	let global: Record<string, unknown> = {};
	try {
		const raw = readFileSync(join(agentDir, "settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			global = parsed as Record<string, unknown>;
		}
	} catch {
		// Missing or corrupt global settings are not fatal: defaults apply.
	}

	const safe: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(global)) {
		if (PROJECT_SCOPED_SETTINGS_KEYS.includes(key)) continue;
		safe[key] = value;
	}
	// A child never compacts or retries on its own: budgets are the only
	// continuation control, and silent retries would make token accounting lie.
	safe.compaction = { enabled: false };
	safe.retry = { enabled: false };
	return SettingsManager.inMemory(safe as Parameters<typeof SettingsManager.inMemory>[0]);
}

/**
 * Create the in-process runner. The returned runner is stateless between runs:
 * every run builds its own session, budget tracker and abort wiring, and
 * disposes the session in `finally`.
 */
export function createInProcessRunner(deps: InProcessRunnerDeps): Runner {
	return {
		kind: "process",
		async run(plan: RunPlan, options: RunOptions): Promise<RunResult> {
			return runInProcess(plan, options, deps);
		},
	};
}

/**
 * Build the child resource loader.
 *
 * Every discovery source is off, and the loader is pointed at the agent dir
 * rather than the target repository, so there is no path by which a hostile
 * `.pi/skills/**`, `.pi/extensions/**` or `AGENTS.md` can reach the child.
 * Exported so the SDK integration test asserts this without a model call.
 */
export function createChildResourceLoader(agentDir: string, systemPrompt: string): DefaultResourceLoader {
	if (agentDir.trim().length === 0) {
		throw new Error("createChildResourceLoader requires a non-empty agentDir");
	}
	return new DefaultResourceLoader({
		// Neutral cwd: the loader must never be pointed at the target repo.
		cwd: agentDir,
		agentDir,
		settingsManager: createChildSettingsManager(agentDir),
		systemPrompt,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
}

async function runInProcess(plan: RunPlan, options: RunOptions, deps: InProcessRunnerDeps): Promise<RunResult> {
	const startedAt = options.now();
	const tracker = new BudgetTracker(plan.budgets, options.now);
	const diagnostics = [...plan.diagnostics];
	const sandboxProbe = deps.isSandboxAvailable ?? (() => isSandboxAvailable());

	// An already-aborted signal must not start a session at all: the caller has
	// withdrawn the request, so no work should be scheduled.
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

	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let text = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let stopped: RunResult["stopped"];
	let aborted = false;

	const emit = (partial: boolean) => {
		if (!options.onUpdate) return;
		options.onUpdate({
			agent: plan.agentName,
			ok: errorMessage === undefined && stopped === undefined,
			partial,
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

	const abortListener = () => {
		aborted = true;
		try {
			session?.abort();
		} catch {
			/* session already gone */
		}
	};
	options.signal.addEventListener("abort", abortListener, { once: true });

	try {
		const resourceLoader = createChildResourceLoader(deps.agentDir, plan.systemPrompt);
		await resourceLoader.reload();

		// The sandboxed bash is a custom tool definition that replaces the built-in
		// one: pi's own bash tool is never reachable when `sandbox: os` is set.
		const customTools: ToolDefinition<any, any, any>[] = [];
		if (plan.sandbox === "os" && plan.tools.includes("bash")) {
			if (!sandboxProbe()) {
				return failure(
					plan,
					tracker,
					startedAt,
					options,
					`sandbox: os requested but ${sandboxUnavailableReason()}`,
				);
			}
			const local = createLocalBashOperations();
			customTools.push(
				createBashToolDefinition(plan.cwd, {
					operations: createSandboxedBashOperations(local, { writeRoots: [plan.cwd] }),
				}),
			);
		}

		const modelRuntime = deps.modelRuntime;
		const model = plan.model !== undefined ? deps.resolveModel?.(plan.model) : undefined;

		const created = await createAgentSession({
			cwd: plan.cwd,
			agentDir: deps.agentDir,
			...(modelRuntime ? { modelRuntime } : {}),
			...(model ? { model: resolveRuntimeModel(modelRuntime, model) } : {}),
			...(plan.thinking ? { thinkingLevel: plan.thinking } : {}),
			tools: plan.tools,
			...(plan.noTools ? { noTools: plan.noTools } : {}),
			...(customTools.length > 0 ? { customTools } : {}),
			// In-memory: no session file, no transcript, nothing under the target repo.
			sessionManager: SessionManager.inMemory(plan.cwd),
			settingsManager: createChildSettingsManager(deps.agentDir),
			resourceLoader,
		});
		session = created.session;

		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_end") {
				const message = event.message as {
					role?: string;
					content?: unknown;
					stopReason?: string;
					errorMessage?: string;
				};
				if (message.role === "assistant") {
					tracker.noteTurn();
					tracker.noteUsage(readUsage(message));
					if (typeof message.stopReason === "string") stopReason = message.stopReason;
					if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
					const final = extractText(message.content);
					if (final.length > 0) text = final;
					emit(false);
				}
			} else if (event.type === "turn_end") {
				emit(true);
			}

			if (stopped === undefined && !aborted) {
				const breach = tracker.check();
				if (breach) {
					stopped = budgetStopReason(breach.kind);
					diagnostics.push({ level: "warning", message: breach.message });
					try {
						session?.abort();
					} catch {
						/* already settled */
					}
				}
			}
		});

		await session.prompt(plan.task, { expandPromptTemplates: false });
		await session.agent.waitForIdle();
	} catch (err) {
		if (!errorMessage) errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		options.signal.removeEventListener("abort", abortListener);
		try {
			unsubscribe?.();
		} catch {
			/* ignore */
		}
		try {
			session?.dispose();
		} catch {
			/* ignore */
		}
	}

	if (aborted && stopped === undefined) stopped = "aborted";

	// A time breach is only observable after the fact, so check once more.
	if (stopped === undefined && !aborted) {
		const breach = tracker.check();
		if (breach) {
			stopped = budgetStopReason(breach.kind);
			diagnostics.push({ level: "warning", message: breach.message });
		}
	}

	const partial = stopped !== undefined || (errorMessage !== undefined && text.length > 0);
	return {
		agent: plan.agentName,
		ok: errorMessage === undefined && stopped === undefined,
		partial,
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

/** Resolve a `provider/modelId` pair against the runtime, or undefined. */
function resolveRuntimeModel(
	runtime: ModelRuntime | undefined,
	ref: { provider: string; modelId: string },
): ReturnType<ModelRuntime["getModel"]> {
	if (!runtime) return undefined;
	return runtime.getModel(ref.provider, ref.modelId);
}

function failure(
	plan: RunPlan,
	tracker: BudgetTracker,
	startedAt: number,
	options: RunOptions,
	message: string,
): RunResult {
	return {
		agent: plan.agentName,
		ok: false,
		partial: false,
		stopped: "child-error",
		text: "",
		truncated: false,
		durationMs: options.now() - startedAt,
		turns: tracker.turns,
		usage: tracker.usage ?? zeroUsage(),
		stopReason: undefined,
		errorMessage: message,
		diagnostics: plan.diagnostics,
	};
}

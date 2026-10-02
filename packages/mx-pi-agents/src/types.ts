/**
 * mx-pi-agents shared types.
 *
 * Everything in `src/` is pure logic over these types; pi types only appear at
 * the wiring edges (`index.ts`, `src/runners/*`). Keeping the contracts here
 * means the registry, policy and budget layers are unit-testable without
 * loading pi or a TUI.
 */

import type { ChildTelemetrySink } from "./telemetry.js";

/**
 * Thinking level. Mirrors pi-agent-core's union structurally so this package
 * needs no dependency on pi-agent-core for type-checking; a value of this type
 * is assignable wherever pi expects its own `ThinkingLevel`.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What a definition is for.
 *
 * - `persona` replaces the main system prompt prefix via `#name`; never runs as a child.
 * - `main` appends to the main system prompt via `#name`; may also run as a child.
 * - `sub` is only usable as a child (tool, `#[…]`, or delegation).
 */
export type AgentKind = "persona" | "main" | "sub";

/** How a child session is executed. */
export type IsolationMode = "process" | "subprocess";

/** Optional OS-level sandbox applied to a child's `bash` tool. */
export type SandboxMode = "none" | "os";

/**
 * Where a definition came from. `bundled` and `global` are trusted; `config`
 * (extra `agentPaths`) and `project` (`.pi/agents`) are gated behind approval.
 */
export type SourceKind = "bundled" | "global" | "config" | "project";

/** How a definition with no explicit `tools:` derives its grant set. */
export type ToolsInheritance = "none" | "parent";

/** Validated contents of one agent definition file. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** What the definition is for. Absent frontmatter defaults to `main`. */
	kind: AgentKind;
	/**
	 * Explicit grant set. `undefined` means the field was absent (inheritance
	 * decides); `[]` means the field was present and empty (no tools).
	 */
	tools: string[] | undefined;
	toolsInheritance: ToolsInheritance;
	/**
	 * Directory roots this agent may touch. `undefined` means absent (the run's
	 * cwd); `[]` means the field was present and empty, which is a refusal.
	 * Entries tighten the configured ceiling and are resolved against the cwd.
	 */
	scope: string[] | undefined;
	/**
	 * Main-session skill allow-list. `undefined` means the field was absent (all
	 * loaded skills survive the switch); `[]` means the field was present and
	 * empty (no skills). Ignored for child runs; enforced while this definition
	 * is the active main-session switch.
	 */
	skills: string[] | undefined;
	/**
	 * Main-session project-context-file allow-list, matched by absolute path,
	 * cwd-relative path or basename. Same absent/empty semantics as `skills`.
	 */
	contextFiles: string[] | undefined;
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
	maxTurns: number | undefined;
	timeoutMs: number | undefined;
	tokenBudget: number | undefined;
	costBudget: number | undefined;
	isolation: IsolationMode;
	sandbox: SandboxMode;
	/** Markdown body, trimmed. Becomes the child's system prompt (plus a header). */
	body: string;
}

/** Provenance of a definition file on disk. */
export interface AgentSource {
	kind: SourceKind;
	/** Absolute path of the definition file. */
	path: string;
	/** Base directory the definition was discovered from. */
	directory: string;
	/** True for bundled/global sources; gated sources are `false`. */
	trusted: boolean;
}

/** A definition read at `session_start`, with the hash it had at that moment. */
export interface PinnedAgent {
	definition: AgentDefinition;
	source: AgentSource;
	/** SHA-256 of the raw file bytes at pin time. */
	hash: string;
	/** Epoch ms when the definition was pinned. */
	pinnedAt: number;
}

/** Non-fatal problem discovered while loading definitions. */
export interface AgentDiagnostic {
	level: "info" | "warning" | "error";
	message: string;
	path?: string;
}

/** Result of one registry discovery pass. */
export interface RegistrySnapshot {
	agents: PinnedAgent[];
	diagnostics: AgentDiagnostic[];
	pinnedAt: number;
}

/** Token/cost usage accumulated from a child run. */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Last observed total context size, when the runner can report it. */
	contextTokens: number;
}

export function zeroUsage(): TokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

/** Hard caps applied to a single child run. */
export interface Budgets {
	maxTurns: number;
	timeoutMs: number;
	tokenBudget: number;
	costBudget: number | undefined;
}

/** Why a run was refused before any child session was created. */
export type RefusalReason =
	| "unknown-agent"
	| "unapproved-project-agent"
	| "definition-changed"
	| "definition-invalid"
	| "unresolved-tool"
	| "spawn-tool-grant"
	| "scope-invalid"
	| "scope-unenforceable"
	| "recursion"
	| "model-unavailable"
	| "sandbox-unavailable"
	| "persona-child"
	| "invalid-request"
	| "child-session";

/** A refusal. Never carries a runnable plan. */
export interface Refusal {
	reason: RefusalReason;
	message: string;
	diagnostics: AgentDiagnostic[];
}

export type PlanOutcome = { ok: true; plan: RunPlan } | { ok: false; refusal: Refusal };

/** Everything a runner needs to start one child session. Computed, never declared. */
export interface RunPlan {
	agentName: string;
	source: AgentSource;
	task: string;
	/** Effective grant set. Never inferred beyond the §4.4 contract. */
	tools: string[];
	/** `"all"` when the grant set is empty, so pi starts with no tools at all. */
	noTools: "all" | undefined;
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
	systemPrompt: string;
	budgets: Budgets;
	isolation: IsolationMode;
	sandbox: SandboxMode;
	cwd: string;
	/**
	 * Effective path scope. `roots` are absolute directories the run may touch;
	 * `unrestricted` is true only when an explicit `/` ceiling licensed an
	 * unconfineable vector, in which case tool wrapping is skipped.
	 */
	scope: { roots: readonly string[]; unrestricted: boolean };
	diagnostics: AgentDiagnostic[];
}

/** Terminal state of one child run. */
export interface RunResult {
	agent: string;
	/** False when the run refused, aborted, hit a budget, or the child errored. */
	ok: boolean;
	/** True when the run was cut short by a budget and the text is partial. */
	partial: boolean;
	/** Why the run stopped early: a budget breach, abort, or child error. */
	stopped: "budget-turns" | "budget-time" | "budget-tokens" | "budget-cost" | "aborted" | "child-error" | undefined;
	/** Final assistant text, already capped. */
	text: string;
	/** True when `text` was truncated by the output cap. */
	truncated: boolean;
	durationMs: number;
	turns: number;
	usage: TokenUsage;
	stopReason: string | undefined;
	errorMessage: string | undefined;
	diagnostics: AgentDiagnostic[];
}

/** Options passed to a runner for one run. */
export interface RunOptions {
	/** External cancellation (parent tool call aborted). */
	signal: AbortSignal;
	/** Streaming partial results, used for tool-call progress updates. */
	onUpdate?: (partial: RunResult) => void;
	/** Injected clock; tests pass a controllable one. */
	now: () => number;
	/**
	 * When set, the runner publishes the child's lifecycle events for tracing.
	 * Absent means no telemetry is collected or forwarded.
	 */
	telemetry?: ChildTelemetrySink;
}

/**
 * Runtime state captured before the first main-session switch of a session.
 * `#none` restores exactly this; it survives later switches.
 */
export interface SwitchBaseline {
	tools: string[];
	/** `provider/id` label, or undefined when no model was set. */
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
}

/** The subset of baseline fields a switch declares and therefore changes. */
export interface SwitchApplied {
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
}

/**
 * A `persona`/`main` switch plan produced by the pure persona module. The
 * wiring layer applies it verbatim; it never interprets it.
 */
export interface SwitchPlan {
	name: string;
	kind: "persona" | "main";
	/** How the definition body mutates the main system prompt. */
	prompt: { mode: "replace" | "append"; body: string };
	applied: SwitchApplied;
}

/**
 * Persisted switch state (`customType: "mx-pi-agents.switch"`). A `name` of
 * `null` is a reset entry. Entries never participate in LLM context.
 */
export interface SwitchEntryData {
	name: string | null;
	kind?: AgentKind;
	baseline: SwitchBaseline;
	applied?: SwitchApplied;
	switchedAt: number;
}

/** Executes one planned run. Implementations: in-process and subprocess. */
export interface Runner {
	readonly kind: IsolationMode;
	run(plan: RunPlan, options: RunOptions): Promise<RunResult>;
}

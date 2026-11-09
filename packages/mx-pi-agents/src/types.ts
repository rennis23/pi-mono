/**
 * mx-pi-agents shared types.
 *
 * Everything in `src/` is pure logic over these types; pi types only appear at
 * the wiring edge (`index.ts`). Keeping the contracts here means the registry,
 * trust and persona layers are unit-testable without loading pi or a TUI.
 */

/**
 * Thinking level. Mirrors pi-agent-core's union structurally so this package
 * needs no dependency on pi-agent-core for type-checking; a value of this type
 * is assignable wherever pi expects its own `ThinkingLevel`.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * How a definition's body mutates the main system prompt.
 *
 * - `replace` replaces the default prompt prefix via `before_agent_start`.
 * - `append` appends the body as an addendum to the system prompt.
 *
 * Absent frontmatter defaults to `append`.
 */
export type SystemPromptMode = "replace" | "append";

/**
 * Where a definition came from. `bundled` and `global` are trusted; `config`
 * (extra `agentPaths`) and `project` (`.pi/agents`) are gated behind approval.
 */
export type SourceKind = "bundled" | "global" | "config" | "project";

/** Validated contents of one agent definition file. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** How the body mutates the main system prompt. Absent frontmatter = `append`. */
	systemPrompt: SystemPromptMode;
	/**
	 * Main-session tool preset. `undefined` means the field was absent (leave the
	 * active tools untouched); `[]` means the field was present and empty (no
	 * tools); a list is an exact preset.
	 */
	tools: string[] | undefined;
	/**
	 * Main-session skill allow-list. `undefined` means the field was absent (all
	 * loaded skills survive the switch); `[]` means the field was present and
	 * empty (no skills). Enforced while this definition is the active switch.
	 */
	skills: string[] | undefined;
	/**
	 * Main-session project-context-file allow-list, matched by absolute path,
	 * cwd-relative path or basename. Same absent/empty semantics as `skills`.
	 */
	contextFiles: string[] | undefined;
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
	/** Markdown body, trimmed. How it mutates the prompt is decided by `systemPrompt`. */
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
 * A switch plan produced by the pure persona module. The wiring layer applies
 * it verbatim; it never interprets it.
 */
export interface SwitchPlan {
	name: string;
	mode: SystemPromptMode;
	applied: SwitchApplied;
}

/**
 * Persisted switch state (`customType: "mx-pi-agents.switch"`). A `name` of
 * `null` is a reset entry. Entries never participate in LLM context.
 */
export interface SwitchEntryData {
	name: string | null;
	mode?: SystemPromptMode;
	baseline: SwitchBaseline;
	applied?: SwitchApplied;
	switchedAt: number;
}

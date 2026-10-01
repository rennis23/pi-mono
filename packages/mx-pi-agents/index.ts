/**
 * mx-pi-agents
 *
 * A secure agent registry and subagent runner for pi.
 *
 * What it adds:
 * - `mx_pi_agent` — delegate to a named agent in single, parallel or chain mode
 * - `/mx-pi-agents list|approve|status` — inspect and approve the roster
 * - `--mx-pi-agents-*` flags — one-run overrides
 *
 * Security posture (details in SECURITY.md):
 * - definitions are pinned and hashed at `session_start`; an edit refuses the run
 * - project and config-sourced agents are gated behind approval
 * - capability grants are total and fail closed; nothing widens them
 * - children get in-memory sessions, no discovery, and hard budgets
 * - the extension refuses to run inside a child (`MX_PI_AGENTS_CHILD=1`)
 *
 * This file owns no computation: it wires events, the tool, the command and the
 * flags, and delegates every decision to `src/`.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, TUI } from "@earendil-works/pi-tui";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { completionItems, directiveContext, toCompletionSource } from "./src/complete.js";
import { type AgentsConfig, createConfigStore } from "./src/config.js";
import { parseDirective } from "./src/directive.js";
import {
	type DelegationOutcome,
	type DelegationStep,
	type OrchestratorDeps,
	type PipelineStage,
	runChain,
	runParallel,
	runPipeline,
	runSingle,
} from "./src/modes.js";
import { aggregateResults, createRedactor, DEFAULT_PER_RESULT_BYTES, DEFAULT_TOTAL_BYTES } from "./src/output.js";
import {
	dispatchDirective,
	lastSwitchEntry,
	planReset,
	planSwitch,
	rehydrate as rehydratePersona,
	snapshotBaseline,
} from "./src/persona.js";
import { describeRefusal } from "./src/policy.js";
import {
	createProgress,
	markRemaining,
	markRunning,
	markSettled,
	type ProgressModel,
	renderProgress,
	SPINNER_FRAMES,
} from "./src/progress.js";
import { bundledAgentsDir, discoverAgents, type RegistryDirs, rosterEntries, verifyPinned } from "./src/registry.js";
import {
	type AgentToolDetails,
	formatSwitchNotice,
	renderCallLines,
	renderDiagnostics,
	renderDirectiveMessage,
	renderResultLines,
	renderRosterLines,
} from "./src/render.js";
import { type RunnerRegistry, selectRunner, unavailableRunner } from "./src/runner.js";
import { createInProcessRunner } from "./src/runners/in-process.js";
import { isSandboxAvailable } from "./src/runners/sandbox.js";
import { CHILD_ENV_MARKER, createSubprocessRunner } from "./src/runners/subprocess.js";
import { CHILD_TELEMETRY_CHANNEL, type ChildTelemetrySink } from "./src/telemetry.js";
import { approvalRequest, checkTrust, gatedAgents, recordApproval, withApprovals } from "./src/trust.js";
import {
	type AgentDiagnostic,
	type PinnedAgent,
	type RunPlan,
	type RunResult,
	type SwitchApplied,
	type SwitchBaseline,
	type SwitchEntryData,
	type SwitchPlan,
	type ThinkingLevel,
	zeroUsage,
} from "./src/types.js";

const CHILD_MARKER_VALUE = "1";

/** Custom entry type persisting a main-session switch (never sent to the model). */
const SWITCH_ENTRY_TYPE = "mx-pi-agents.switch";

/** Status key publishing the active main-session persona in the native footer. */
const PERSONA_STATUS_KEY = "mx-pi-agents-persona";

/** Custom message type for a `#` directive result appended to the transcript. */
const DIRECTIVE_MESSAGE = "mx-pi-agents.directive";

/**
 * Stack a `#`-directive autocomplete provider on top of the built-in one.
 *
 * Outside a directive context every call is delegated to `current`, so this
 * provider can never shadow built-in file or command completion. Inside one it
 * returns registry items and a `prefix` that the editor's generic
 * `applyCompletion` branch replaces with `item.value`.
 */
function createDirectiveAutocomplete(
	current: AutocompleteProvider,
	getRoster: () => PinnedAgent[],
): AutocompleteProvider {
	return {
		triggerCharacters: ["#"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			try {
				const line = lines[cursorLine] ?? "";
				const context = directiveContext(line.slice(0, cursorCol));
				if (context === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				return { items: completionItems(toCompletionSource(getRoster()), context), prefix: context.prefix };
			} catch {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	};
}

const PROGRESS_WIDGET_KEY = "mx-pi-agents-progress";

/**
 * Persistent progress widget shown above the editor while a delegation runs.
 *
 * Modeled on pi-code's todo overlay: register once in factory form, live-read
 * the model from `render`, and drive the spinner with a timer that calls
 * `requestRender()`. Every pi call is wrapped, so a disposing session or a
 * terminal without widget support degrades to the result message instead of
 * crashing the run.
 */
class AgentProgressOverlay {
	private uiCtx?: ExtensionUIContext;
	private widgetRegistered = false;
	private tui?: TUI;
	private model?: ProgressModel;
	private frame = 0;
	private timer?: ReturnType<typeof setInterval>;

	setUICtx(ui: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent and a
		// reload (new ctx) re-registers the widget.
		if (ui !== this.uiCtx) {
			this.uiCtx = ui;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	show(model: ProgressModel): void {
		this.model = model;
		this.frame = 0;
		if (!this.uiCtx) return;
		this.register();
		this.startTimer();
	}

	refresh(): void {
		try {
			this.tui?.requestRender();
		} catch {
			/* a disposing TUI must not crash the run */
		}
	}

	hide(): void {
		this.stopTimer();
		this.model = undefined;
		if (!this.widgetRegistered) return;
		try {
			this.uiCtx?.setWidget(PROGRESS_WIDGET_KEY, undefined);
		} catch {
			/* ignore */
		}
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	dispose(): void {
		this.hide();
		this.uiCtx = undefined;
	}

	private register(): void {
		if (this.widgetRegistered) {
			this.refresh();
			return;
		}
		try {
			this.uiCtx?.setWidget(
				PROGRESS_WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => {
							if (!this.model) return [];
							return renderProgress(this.model, theme, this.frame).map((line) =>
								truncateToWidth(line, width, "…"),
							);
						},
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} catch {
			/* widget support is optional; the result message still reports the run */
		}
	}

	private startTimer(): void {
		this.stopTimer();
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.refresh();
		}, 100);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private stopTimer(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}
}

const USAGE =
	"Usage: /mx-pi-agents [list | approve [name] | status | refresh]\n" +
	"  list     show the roster with source, trust and pinned hash\n" +
	"  approve  review and approve gated (project/config) agents\n" +
	"  status   show config path, limits and sandbox availability\n" +
	"  refresh  re-pin the registry from disk (invalidates approvals on change)";

/** Non-interactive override that lets tests drive approval without a TUI. */
const DEFAULT_PARAMS = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task text (single mode)" })),
	tasks: Type.Optional(
		Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), {
			description: "Parallel mode: up to 8 independent {agent, task} pairs",
		}),
	),
	chain: Type.Optional(
		Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), {
			description: "Chain mode: sequential steps; {previous} in a task is replaced by the prior output",
		}),
	),
});

/**
 * Agent dir implied by the config store path: `<agentDir>/extensions/<file>`.
 * Falls back to pi's own resolution when the path does not have that shape.
 *
 * Never returns an empty string: an empty agent dir would make
 * `<agentDir>/settings.json` resolve against `process.cwd()` — the target
 * repository — which is exactly the vector the child settings manager exists to
 * close.
 */
function agentDirFromPath(configPath: string): string {
	const marker = "/extensions/";
	const index = configPath.lastIndexOf(marker);
	if (index > 0) return configPath.slice(0, index);
	const dir = getAgentDir();
	if (dir.trim().length === 0) throw new Error("mx-pi-agents: could not resolve the agent directory");
	return dir;
}

/**
 * Build the child-telemetry publisher for one delegation.
 *
 * Every agent of the call shares one `delegationId`; each child run adds its
 * own `runId` inside the runner. The parent session id is carried so a consumer
 * can nest child spans under the session it already traces. A missing event bus
 * or session id disables telemetry instead of failing the run.
 */
function createChildTelemetrySink(pi: ExtensionAPI, ctx: ExtensionContext): ChildTelemetrySink | undefined {
	try {
		const events = pi.events;
		if (!events) return undefined;
		return {
			delegationId: randomUUID(),
			parentSessionId: ctx.sessionManager.getSessionId(),
			emit: (envelope) => {
				try {
					events.emit(CHILD_TELEMETRY_CHANNEL, envelope);
				} catch {
					/* telemetry is best-effort and must not disturb the run */
				}
			},
		};
	} catch {
		return undefined;
	}
}

export default function mxPiAgents(pi: ExtensionAPI) {
	// Defense in depth: a marked child never registers the tool at all, so a
	// child cannot delegate even if this extension were somehow loaded into it.
	if (process.env[CHILD_ENV_MARKER] === CHILD_MARKER_VALUE) return;

	const configStore = createConfigStore();
	// The agent dir is resolved once, from the config store path, and threaded
	// into every child-session construction. It is never `""`: an empty dir would
	// make `<agentDir>/settings.json` resolve against `process.cwd()`, which is
	// the target repository.
	const agentDir = agentDirFromPath(configStore.path);
	const overlay = new AgentProgressOverlay();
	let config: AgentsConfig = { version: 1, agentPaths: [], approvals: {}, limits: {} };
	let roster: PinnedAgent[] = [];
	let diagnostics: AgentDiagnostic[] = [];

	/** Baseline captured before the first switch of the session; survives switches. */
	let baseline: SwitchBaseline | undefined;
	/** Active main-session switch, when one is applied. */
	let activeSwitch: { name: string; kind: "persona" | "main"; applied: SwitchApplied } | undefined;
	/** Guards the single auto-deactivation notification per switch. */
	let switchDeactivatedNotified = false;

	const inProcess = createInProcessRunner({ agentDir });
	const subprocess = createSubprocessRunner({
		resolvePi: () => {
			const script = process.argv[1];
			if (script !== undefined && script.length > 0) return { command: process.execPath, args: [script] };
			return { command: "pi", args: [] };
		},
	});

	pi.registerFlag("mx-pi-agents-list", {
		type: "boolean",
		description: "Print the mx-pi-agents roster on startup and exit the check",
	});
	pi.registerFlag("mx-pi-agents-disable", {
		type: "boolean",
		description: "Disable mx_pi_agent delegation for this run",
	});

	function registryDirs(ctx: ExtensionContext): RegistryDirs {
		return { agentDir, cwd: ctx.cwd, agentPaths: config.agentPaths };
	}

	/** Label for a main-session model, stable across sessions. */
	function modelLabel(model: ExtensionContext["model"]): string | undefined {
		if (!model) return undefined;
		return `${model.provider}/${model.id}`;
	}

	/** Resolve a `provider/id` label against the main session's model registry. */
	function resolveModel(ctx: ExtensionContext, label: string): ExtensionContext["model"] {
		const [provider, modelId] = label.includes("/") ? label.split("/", 2) : ["", label];
		try {
			if (provider.length > 0) return ctx.modelRegistry.find(provider, modelId);
			return ctx.modelRegistry.getAll().find((model) => model.id === modelId);
		} catch {
			return undefined;
		}
	}

	/** Whether a `provider/id` label is available with configured credentials. */
	function modelAvailable(ctx: ExtensionContext, label: string): boolean {
		const [provider, modelId] = label.includes("/") ? label.split("/", 2) : ["", label];
		try {
			if (provider.length > 0) return ctx.modelRegistry.find(provider, modelId) !== undefined;
			return ctx.modelRegistry.getAll().some((model) => model.id === modelId);
		} catch {
			return false;
		}
	}

	/** Tool names that resolve in the main session. */
	function mainToolNames(): string[] {
		try {
			const all = pi.getAllTools();
			if (Array.isArray(all) && all.length > 0) return all.map((tool) => tool.name);
		} catch {
			/* fall through to the active set */
		}
		try {
			return pi.getActiveTools();
		} catch {
			return [];
		}
	}

	/** Snapshot of the main session's switching-relevant runtime state. */
	function currentRuntime(ctx: ExtensionContext): {
		tools: string[];
		model: string | undefined;
		thinking: ThinkingLevel | undefined;
	} {
		let tools: string[] = [];
		let thinking: ThinkingLevel | undefined;
		try {
			tools = pi.getActiveTools();
		} catch {
			tools = [];
		}
		try {
			thinking = pi.getThinkingLevel();
		} catch {
			thinking = undefined;
		}
		return { tools, model: modelLabel(ctx.model), thinking };
	}

	/** Apply only the fields a switch declared, then record it in the session. */
	async function applySwitchPlan(ctx: ExtensionContext, plan: SwitchPlan): Promise<void> {
		if (baseline === undefined) baseline = snapshotBaseline(currentRuntime(ctx));
		if (plan.applied.tools !== undefined) {
			try {
				pi.setActiveTools(plan.applied.tools);
			} catch {
				/* a disposing session must not crash the switch */
			}
		}
		if (plan.applied.model !== undefined) {
			const model = resolveModel(ctx, plan.applied.model);
			if (model) {
				try {
					await pi.setModel(model);
				} catch {
					/* ignore */
				}
			}
		}
		if (plan.applied.thinking !== undefined) {
			try {
				pi.setThinkingLevel(plan.applied.thinking);
			} catch {
				/* ignore */
			}
		}
		activeSwitch = { name: plan.name, kind: plan.kind, applied: plan.applied };
		switchDeactivatedNotified = false;
		try {
			ctx.ui.setStatus(PERSONA_STATUS_KEY, `${plan.kind}:${plan.name}`);
		} catch {
			/* ignore */
		}
		try {
			pi.appendEntry(SWITCH_ENTRY_TYPE, {
				name: plan.name,
				kind: plan.kind,
				baseline,
				applied: plan.applied,
				switchedAt: Date.now(),
			} satisfies SwitchEntryData);
		} catch {
			/* persistence is best-effort */
		}
	}

	/** Restore the pre-switch baseline and clear the active switch. */
	async function resetSwitch(ctx: ExtensionContext): Promise<void> {
		if (baseline !== undefined) {
			const restore = planReset(baseline, {
				availableTools: mainToolNames(),
				isModelAvailable: (label) => modelAvailable(ctx, label),
			});
			try {
				pi.setActiveTools(restore.tools);
			} catch {
				/* ignore */
			}
			if (restore.model !== undefined) {
				const model = resolveModel(ctx, restore.model);
				if (model) {
					try {
						await pi.setModel(model);
					} catch {
						/* ignore */
					}
				}
			}
			if (restore.thinking !== undefined) {
				try {
					pi.setThinkingLevel(restore.thinking);
				} catch {
					/* ignore */
				}
			}
			for (const warning of restore.warnings) ctx.ui.notify(`mx-pi-agents: ${warning}`, "warning");
		}
		activeSwitch = undefined;
		switchDeactivatedNotified = false;
		try {
			ctx.ui.setStatus(PERSONA_STATUS_KEY, undefined);
		} catch {
			/* ignore */
		}
		try {
			pi.appendEntry(SWITCH_ENTRY_TYPE, {
				name: null,
				baseline: baseline ?? snapshotBaseline(currentRuntime(ctx)),
				switchedAt: Date.now(),
			} satisfies SwitchEntryData);
		} catch {
			/* ignore */
		}
	}

	/**
	 * Deactivate a switch whose definition vanished or changed. The base prompt
	 * continues; the operator is told once per switch.
	 */
	function deactivateSwitch(ctx: ExtensionContext, message: string): void {
		activeSwitch = undefined;
		try {
			ctx.ui.setStatus(PERSONA_STATUS_KEY, undefined);
		} catch {
			/* ignore */
		}
		if (switchDeactivatedNotified) return;
		switchDeactivatedNotified = true;
		try {
			ctx.ui.notify(`mx-pi-agents: ${message}`, "warning");
		} catch {
			/* ignore */
		}
	}

	/** Apply the preset fields of a rehydrated switch (only when it still reflects the switch). */
	function applyPresetFields(ctx: ExtensionContext, applied: SwitchApplied): void {
		if (applied.tools !== undefined) {
			try {
				pi.setActiveTools(applied.tools);
			} catch {
				/* ignore */
			}
		}
		if (applied.thinking !== undefined) {
			try {
				pi.setThinkingLevel(applied.thinking);
			} catch {
				/* ignore */
			}
		}
		if (applied.model !== undefined) {
			const model = resolveModel(ctx, applied.model);
			if (model) {
				try {
					void pi.setModel(model).catch(() => undefined);
				} catch {
					/* ignore */
				}
			}
		}
	}

	/** Rebuild the active switch from the session branch, if one was persisted. */
	async function rehydrateSwitch(ctx: ExtensionContext): Promise<void> {
		try {
			const entry = lastSwitchEntry(ctx.sessionManager.getBranch());
			if (entry) baseline = entry.baseline;
			const decision = rehydratePersona(entry, currentRuntime(ctx));
			if (!decision.active) {
				activeSwitch = undefined;
				return;
			}
			activeSwitch = { name: decision.name, kind: decision.kind, applied: decision.applied };
			switchDeactivatedNotified = false;
			try {
				ctx.ui.setStatus(PERSONA_STATUS_KEY, `${decision.kind}:${decision.name}`);
			} catch {
				/* ignore */
			}
			if (decision.applyPreset) applyPresetFields(ctx, decision.applied);
		} catch {
			/* persistence is best-effort; a session without it stays plain pi */
		}
	}

	/** Load config and pin the roster. Called at session start and on refresh. */
	function pin(ctx: ExtensionContext): void {
		const loaded = configStore.load();
		config = loaded.config;
		diagnostics = loaded.diagnostics;

		const discovery = discoverAgents(registryDirs(ctx), () => Date.now());
		roster = discovery.agents;
		diagnostics.push(...discovery.diagnostics);
	}

	/** Available tool names in a child: the built-ins plus this extension's tool. */
	function availableChildTools(): string[] {
		return ["read", "bash", "edit", "write", "grep", "find", "ls"];
	}

	function sessionContext(ctx: ExtensionContext): OrchestratorDeps["context"] {
		return {
			cwd: ctx.cwd,
			parentTools: pi.getActiveTools(),
			availableTools: availableChildTools(),
			limits: config.limits,
			scopeCeiling: config.scope,
			sandboxAvailable: isSandboxAvailable(),
			isModelAvailable: (label) => {
				const [provider, modelId] = label.includes("/") ? label.split("/", 2) : ["", label];
				try {
					if (provider.length > 0) return ctx.modelRegistry.find(provider, modelId) !== undefined;
					return ctx.modelRegistry.getAll().some((model) => model.id === modelId);
				} catch {
					return false;
				}
			},
		};
	}

	/**
	 * Trust gate. Interactive sessions may prompt; headless ones refuse. The
	 * approval is written back to the config file only after a confirmed yes.
	 */
	async function authorize(
		agent: PinnedAgent,
		ctx: ExtensionContext,
	): Promise<{ ok: true } | { ok: false; refusal: ReturnType<typeof describeRefusal> }> {
		const decision = checkTrust(agent, {
			hasUI: ctx.hasUI,
			approvals: config.approvals,
			now: () => Date.now(),
		});
		if (decision.ok) return { ok: true };
		if (!decision.needsApproval) {
			return { ok: false, refusal: describeRefusal(decision.refusal) };
		}

		const request = approvalRequest(agent);
		const confirmed = await ctx.ui.confirm(
			"Run a gated agent?",
			`${request.summary}\n\nThis definition is not trusted. Approving pins its current hash; any edit requires re-approval.`,
		);
		if (!confirmed) {
			return { ok: false, refusal: `Refused: "${agent.definition.name}" was not approved.` };
		}

		config = withApprovals(config, recordApproval(config.approvals, agent, Date.now()));
		try {
			configStore.save(config);
		} catch (err) {
			ctx.ui.notify(
				`mx-pi-agents: approved for this session but could not save: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
		return { ok: true };
	}

	function runners(): RunnerRegistry {
		return { process: inProcess, subprocess };
	}

	/** Build orchestrator deps, binding the trust gate to this session's ctx. */
	function deps(ctx: ExtensionContext): OrchestratorDeps {
		return {
			agents: roster,
			context: sessionContext(ctx),
			selectRunner: (plan: RunPlan) => {
				const runner = selectRunner(runners(), plan);
				return runner;
			},
			now: () => Date.now(),
		};
	}

	/**
	 * Plan and run a delegation, shared by the `mx_pi_agent` tool and the `#`
	 * input handler so the trust gate, hash re-verification, budgets and path
	 * scope cannot drift between the two entry points.
	 *
	 * The trust gate is async, so every distinct agent is authorized up front and
	 * the result is mapped back into the synchronous orchestrator `authorize`.
	 */
	async function runDelegation(
		request: {
			kind: "single" | "parallel" | "chain" | "pipeline";
			steps?: DelegationStep[];
			stages?: PipelineStage[];
			task?: string;
		},
		ctx: ExtensionContext,
		options: { signal: AbortSignal; onUpdate?: (results: RunResult[], total: number) => void },
	): Promise<{ text: string; details: AgentToolDetails; cancelled?: boolean }> {
		const orchestration = deps(ctx);
		const steps = request.steps ?? [];
		const stages = request.stages ?? [];
		const names =
			request.kind === "pipeline"
				? [...new Set(stages.flatMap((stage) => [...stage.agents]))]
				: [...new Set(steps.map((step) => step.agent))];

		const refusalByAgent = new Map<string, string>();
		for (const name of names) {
			const agent = roster.find((candidate) => candidate.definition.name === name);
			if (!agent) continue;
			const decision = await authorize(agent, ctx);
			if (!decision.ok) refusalByAgent.set(name, decision.refusal);
		}
		orchestration.authorize = (agent) => {
			const refusal = refusalByAgent.get(agent.definition.name);
			if (refusal === undefined) return { ok: true };
			return {
				ok: false,
				refusal: { reason: "unapproved-project-agent", message: refusal, diagnostics: [] },
			};
		};

		const total =
			request.kind === "pipeline" ? stages.reduce((count, stage) => count + stage.agents.length, 0) : steps.length;
		const runOptions = {
			signal: options.signal,
			now: () => Date.now(),
			onUpdate: options.onUpdate ? (partial: RunResult) => options.onUpdate?.([partial], total) : undefined,
			telemetry: createChildTelemetrySink(pi, ctx),
		};

		// Build the display model before anything runs, so the widget can list
		// waiting agents while the first one is still starting.
		const progressStages =
			request.kind === "pipeline"
				? stages.map((stage) => ({ agents: [...stage.agents] }))
				: request.kind === "parallel"
					? [{ agents: steps.map((step) => step.agent) }]
					: steps.map((step) => ({ agents: [step.agent] }));
		const model = createProgress(progressStages);
		orchestration.onStep = (event) => {
			if (event.phase === "start") markRunning(model, event.stage, event.agent);
			else markSettled(model, event.stage, event.agent, event.ok === true);
			overlay.refresh();
		};
		overlay.show(model);

		let outcome: DelegationOutcome | undefined;
		try {
			outcome =
				request.kind === "pipeline"
					? await runPipeline(stages, request.task ?? "", orchestration, runOptions)
					: request.kind === "parallel"
						? await runParallel(steps, orchestration, runOptions)
						: request.kind === "chain"
							? await runChain(steps, orchestration, runOptions)
							: await runSingle(steps[0], orchestration, runOptions);
		} finally {
			// Whatever is still waiting or running was stopped early; on an abort
			// it was cancelled, otherwise it never got to start.
			markRemaining(model, options.signal.aborted ? "cancelled" : "failed");
			overlay.hide();
		}

		if (options.signal.aborted || outcome === undefined) {
			const message = "Cancelled: the delegation was aborted.";
			return {
				text: message,
				details: { mode: request.kind, results: [], diagnostics: [], refusalReason: message },
				cancelled: true,
			};
		}

		const redact = createRedactor(process.env);
		const capped = aggregateResults(outcome.results, {
			perResultBytes: DEFAULT_PER_RESULT_BYTES,
			totalBytes: DEFAULT_TOTAL_BYTES,
		});
		// A refusal that happened before any session exists has no results to
		// render, so the refusal text itself is the whole result.
		const refusalText = outcome.refusal !== undefined ? describeRefusal(outcome.refusal) : "";
		const text = redact(capped.text.length > 0 ? capped.text : refusalText);
		const details: AgentToolDetails = {
			mode: outcome.mode,
			results: outcome.results,
			diagnostics: outcome.diagnostics,
			refusalReason: outcome.refusal?.message,
		};
		return { text, details };
	}

	pi.registerMessageRenderer(
		DIRECTIVE_MESSAGE,
		(message, _options, theme) => new Text(renderDirectiveMessage(message, theme).join("\n"), 0, 0),
	);

	pi.on("session_start", async (_event, ctx) => {
		pin(ctx);
		await rehydrateSwitch(ctx);
		overlay.setUICtx(ctx.ui);
		for (const diagnostic of diagnostics) {
			if (diagnostic.level === "warning") ctx.ui.notify(`mx-pi-agents: ${diagnostic.message}`, "warning");
		}
		if (pi.getFlag("mx-pi-agents-list") === true) {
			ctx.ui.notify(renderRosterLines(rosterEntries(roster), ctx.ui.theme).join("\n"), "info");
		}
		if (ctx.mode === "tui") {
			try {
				ctx.ui.addAutocompleteProvider((current) => createDirectiveAutocomplete(current, () => roster));
			} catch {
				/* no autocomplete in this environment; directives still work */
			}
		}
	});

	pi.on("session_shutdown", async () => {
		overlay.dispose();
	});

	// Re-derived on every turn so the prompt is exact even after a resume, and
	// re-hashed so a mid-session edit deactivates the switch (invariant 12).
	pi.on("before_agent_start", async (event, ctx) => {
		if (activeSwitch === undefined) return;
		try {
			const name = activeSwitch.name;
			const agent = roster.find((candidate) => candidate.definition.name === name);
			if (!agent) {
				deactivateSwitch(ctx, `agent "${name}" was removed; the main-prompt switch was cancelled.`);
				return;
			}
			const verified = verifyPinned(agent);
			if (!verified.ok) {
				deactivateSwitch(ctx, `agent "${name}" changed since session start; the main-prompt switch was cancelled.`);
				return;
			}
			const options = event.systemPromptOptions;
			if (!options) return;
			if (agent.definition.kind === "persona") {
				options.customPrompt = agent.definition.body;
			} else {
				options.appendSystemPrompt = [options.appendSystemPrompt, agent.definition.body]
					.filter((part) => part.length > 0)
					.join("\n\n");
			}
		} catch {
			/* a disposing session must never crash a turn; the base prompt is used */
		}
	});

	pi.on("input", async (event, ctx) => {
		try {
			if (pi.getFlag("mx-pi-agents-disable") === true) return { action: "continue" as const };
			if (event.source !== "interactive") return { action: "continue" as const };

			const parsed = parseDirective(event.text);
			if (parsed === undefined) return { action: "continue" as const };
			if (!parsed.ok) {
				ctx.ui.notify(`mx-pi-agents: ${parsed.message}`, "warning");
				return { action: "handled" as const };
			}
			if ((event.images?.length ?? 0) > 0) {
				ctx.ui.notify("mx-pi-agents: directives cannot carry attached images.", "warning");
				return { action: "handled" as const };
			}
			if (event.streamingBehavior !== undefined) {
				ctx.ui.notify("mx-pi-agents: wait for the current turn before running a directive.", "warning");
				return { action: "handled" as const };
			}

			const directive = parsed.directive;

			// Kind dispatch for a single-name directive happens before any child
			// session exists: persona/main mutate the main session, sub delegates,
			// none resets, anything unknown refuses.
			const singleName =
				!directive.pipeline && directive.stages.length === 1 && directive.stages[0].agents.length === 1
					? directive.stages[0].agents[0]
					: undefined;
			const dispatch =
				singleName !== undefined
					? dispatchDirective({
							name: singleName,
							kind: roster.find((candidate) => candidate.definition.name === singleName)?.definition.kind,
							hasTask: directive.task !== undefined,
						})
					: undefined;

			if (dispatch !== undefined && dispatch.action !== "delegate") {
				if (dispatch.action === "refuse") {
					ctx.ui.notify(`mx-pi-agents: ${dispatch.message}`, "warning");
					return { action: "handled" as const };
				}
				if (dispatch.action === "reset") {
					await resetSwitch(ctx);
					ctx.ui.notify(`mx-pi-agents: ${formatSwitchNotice("", "base")}`, "info");
					return { action: "handled" as const };
				}

				const agent = roster.find((candidate) => candidate.definition.name === singleName);
				if (agent === undefined) {
					ctx.ui.notify(`mx-pi-agents: unknown agent "#${singleName}".`, "warning");
					return { action: "handled" as const };
				}
				if (!agent.source.trusted) {
					const decision = await authorize(agent, ctx);
					if (!decision.ok) {
						ctx.ui.notify(`mx-pi-agents: ${decision.refusal}`, "warning");
						return { action: "handled" as const };
					}
				}
				const verified = verifyPinned(agent);
				if (!verified.ok) {
					ctx.ui.notify(`mx-pi-agents: ${verified.message}`, "warning");
					return { action: "handled" as const };
				}
				const planned = planSwitch(agent, {
					availableTools: mainToolNames(),
					isModelAvailable: (label) => modelAvailable(ctx, label),
				});
				if (!planned.ok) {
					ctx.ui.notify(`mx-pi-agents: ${planned.refusal}`, "warning");
					return { action: "handled" as const };
				}
				await applySwitchPlan(ctx, planned.plan);
				if (directive.task !== undefined) {
					// The switch is applied before this same turn's before_agent_start, so
					// the task runs under the new persona.
					return { action: "transform" as const, text: directive.task };
				}
				ctx.ui.notify(`mx-pi-agents: ${formatSwitchNotice(planned.plan.name, planned.plan.kind)}`, "info");
				return { action: "handled" as const };
			}

			const controller = new AbortController();
			let unsubscribe: (() => void) | undefined;
			try {
				unsubscribe = ctx.ui.onTerminalInput?.((data) => {
					try {
						if (matchesKey(data, "escape")) {
							controller.abort();
							return { consume: true };
						}
					} catch {
						/* not a key we handle */
					}
					return undefined;
				});
			} catch {
				unsubscribe = undefined;
			}
			try {
				const request =
					singleName !== undefined
						? { kind: "single" as const, steps: [{ agent: singleName, task: directive.task ?? "" }] }
						: {
								kind: "pipeline" as const,
								stages: directive.stages.map((stage) => ({ agents: stage.agents })),
								task: directive.task ?? "",
							};
				const { text, details, cancelled } = await runDelegation(request, ctx, { signal: controller.signal });
				pi.sendMessage(
					{ customType: DIRECTIVE_MESSAGE, content: text, display: true, details },
					{ triggerTurn: cancelled !== true },
				);
			} finally {
				try {
					unsubscribe?.();
				} catch {
					/* a disposing session must not crash the handler */
				}
			}
			return { action: "handled" as const };
		} catch (err) {
			try {
				ctx.ui.notify(
					`mx-pi-agents: directive failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			} catch {
				/* ignore */
			}
			return { action: "handled" as const };
		}
	});

	pi.registerTool({
		name: "mx_pi_agent",
		label: "mx_pi_agent",
		description: [
			"Delegate a task to a named agent with an explicit capability grant.",
			"A child can only touch paths inside the run scope (the cwd by default); an out-of-scope read, write or search is refused.",
			"Modes: single ({agent, task}), parallel ({tasks: [...]}, max 8), chain ({chain: [...]}, {previous} substitution).",
			"Agents come from the pinned registry; project agents require approval.",
		].join(" "),
		parameters: DEFAULT_PARAMS,
		executionMode: "parallel",
		// 0.99 tool metadata: permission extensions can gate `mx_pi_agent` on these
		// hints. A child may write files and run bash, so the call is neither
		// read-only nor closed-world.
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		namespace: {
			name: "mx-pi-agents",
			description: "Secure agent delegation",
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (pi.getFlag("mx-pi-agents-disable") === true) {
				const text = "mx_pi_agent is disabled for this run (--mx-pi-agents-disable).";
				return {
					content: [{ type: "text" as const, text }],
					details: {
						mode: "single",
						results: [],
						diagnostics: [],
						refusalReason: text,
					} satisfies AgentToolDetails,
					isError: true,
				};
			}

			const steps: DelegationStep[] = [];
			let mode: AgentToolDetails["mode"] = "single";
			if (Array.isArray(params.tasks) && params.tasks.length > 0) {
				mode = "parallel";
				steps.push(...params.tasks);
			} else if (Array.isArray(params.chain) && params.chain.length > 0) {
				mode = "chain";
				steps.push(...params.chain);
			} else if (typeof params.agent === "string" && typeof params.task === "string") {
				steps.push({ agent: params.agent, task: params.task });
			}

			if (steps.length === 0) {
				const text = `Invalid parameters: provide exactly one of agent+task, tasks, or chain.\n${USAGE}`;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						mode: "single",
						results: [],
						diagnostics: [],
						refusalReason: text,
					} satisfies AgentToolDetails,
					isError: true,
				};
			}

			const abort = signal ?? new AbortController().signal;
			const { text, details } = await runDelegation({ kind: mode, steps }, ctx, {
				signal: abort,
				onUpdate: (results, total) =>
					onUpdate?.({
						content: [{ type: "text", text: `${results.length}/${total} step(s) settled` }],
						details: {
							mode,
							results,
							diagnostics: [],
							refusalReason: undefined,
						} satisfies AgentToolDetails,
					}),
			});

			const failed = details.results.some((result) => !result.ok);
			return {
				content: [{ type: "text" as const, text: text.length > 0 ? text : "(no output)" }],
				details,
				...(failed || details.refusalReason !== undefined ? { isError: true } : {}),
			};
		},

		renderCall(args, theme) {
			return new Text(renderCallLines(args as Parameters<typeof renderCallLines>[0], theme).join("\n"), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AgentToolDetails | undefined;
			if (!details) {
				const first = result.content[0];
				const text = first?.type === "text" ? first.text : "(no output)";
				return new Text(text, 0, 0);
			}
			const lines = renderResultLines(details, theme);
			const extra = renderDiagnostics(details.diagnostics, theme);
			return new Text((extra.length > 0 ? [...lines, ...extra] : lines).join("\n"), 0, 0);
		},
	});

	pi.registerCommand("mx-pi-agents", {
		description: "Inspect and approve the mx-pi-agents roster",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const parts = args
				.trim()
				.split(/\s+/)
				.filter((part) => part.length > 0);
			const command = (parts[0] ?? "").toLowerCase();
			const arg = parts[1];

			switch (command) {
				case "": {
					ctx.ui.notify(renderRosterLines(rosterEntries(roster), ctx.ui.theme).join("\n"), "info");
					return;
				}

				case "list": {
					ctx.ui.notify(renderRosterLines(rosterEntries(roster), ctx.ui.theme).join("\n"), "info");
					return;
				}

				case "status": {
					const sandbox = isSandboxAvailable() ? "available" : "unavailable";
					const scope = config.scope !== undefined && config.scope.length > 0 ? config.scope.join(", ") : "(cwd)";
					const unconfined = config.scope?.some((root) => root === "/") ? "allowed" : "refused";
					const lines = [
						`config: ${configStore.path}`,
						`agents: ${roster.length} (${gatedAgents(roster).length} gated)`,
						`agentPaths: ${config.agentPaths.length > 0 ? config.agentPaths.join(", ") : "(none)"}`,
						`bundled: ${bundledAgentsDir()}`,
						`limits: ${JSON.stringify(config.limits)}`,
						`scope: ${scope}`,
						`unconfined runs: ${unconfined}`,
						`sandbox: os ${sandbox}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				case "refresh": {
					pin(ctx);
					ctx.ui.notify(`mx-pi-agents: re-pinned ${roster.length} agent(s)`, "info");
					return;
				}

				case "approve": {
					const gated =
						arg !== undefined
							? gatedAgents(roster).filter((agent) => agent.definition.name === arg)
							: gatedAgents(roster);
					if (gated.length === 0) {
						ctx.ui.notify(
							arg === undefined ? "No gated agents to approve." : `No gated agent named "${arg}".`,
							"info",
						);
						return;
					}
					if (!ctx.hasUI) {
						ctx.ui.notify("Approval needs an interactive session.", "warning");
						return;
					}
					let approved = 0;
					for (const agent of gated) {
						const request = approvalRequest(agent);
						const confirmed = await ctx.ui.confirm(
							`Approve agent "${agent.definition.name}"?`,
							`${request.summary}\n\nApproving pins this hash; any later edit requires re-approval.`,
						);
						if (!confirmed) continue;
						config = withApprovals(config, recordApproval(config.approvals, agent, Date.now()));
						approved += 1;
					}
					if (approved === 0) {
						ctx.ui.notify("mx-pi-agents: no approvals changed", "info");
						return;
					}
					try {
						configStore.save(config);
					} catch (err) {
						ctx.ui.notify(
							`mx-pi-agents: could not save approvals: ${err instanceof Error ? err.message : String(err)}`,
							"warning",
						);
						return;
					}
					ctx.ui.notify(`mx-pi-agents: approved ${approved} agent(s)`, "info");
					return;
				}

				default: {
					ctx.ui.notify(`Unknown argument: ${command}\n${USAGE}`, "warning");
				}
			}
		},
	});
}

// Keep the failure result shape available to callers that build their own
// runner (used by the security acceptance suite).
export function unavailable(): RunResult {
	return {
		agent: "(none)",
		ok: false,
		partial: false,
		stopped: "child-error",
		text: "",
		truncated: false,
		durationMs: 0,
		turns: 0,
		usage: zeroUsage(),
		stopReason: undefined,
		errorMessage: "unavailable",
		diagnostics: [],
	};
}

export { unavailableRunner };

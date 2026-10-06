/**
 * mx-pi-agents
 *
 * Main-session persona switching for pi.
 *
 * What it adds:
 * - `#name [task]` / `#none` — switch the main session, or reset to plain pi
 * - `/mx-pi-agents list|approve|status|refresh` — inspect and approve the roster
 * - `--mx-pi-agents-*` flags — startup and per-run controls
 * - the `defaultPersona` setting via `@rennis23/mx-pi-settings`
 *
 * Security posture (details in SECURITY.md):
 * - definitions are pinned and hashed at `session_start`; an edit refuses the switch
 * - project and config-sourced definitions are gated behind approval
 * - the preset is total and fail-closed; nothing is applied partially
 * - definition-derived UI text is control-character stripped
 *
 * This file owns no computation: it wires events, the command and the flags, and
 * delegates every decision to `src/`.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { registerSettings } from "@rennis23/mx-pi-settings";
import { completionItems, directiveContext, toCompletionSource } from "./src/complete.js";
import { type AgentsConfig, createConfigStore, defaultConfig } from "./src/config.js";
import { parseDirective } from "./src/directive.js";
import {
	dispatchDirective,
	lastSwitchEntry,
	planReset,
	planSwitch,
	rehydrate as rehydratePersona,
	snapshotBaseline,
} from "./src/persona.js";
import { bundledAgentsDir, discoverAgents, type RegistryDirs, rosterEntries, verifyPinned } from "./src/registry.js";
import { formatSwitchNotice, renderRosterLines } from "./src/render.js";
import { filterContextFiles, filterSkills } from "./src/resources.js";
import { approvalRequest, checkTrust, gatedAgents, recordApproval, withApprovals } from "./src/trust.js";
import type {
	AgentDiagnostic,
	PinnedAgent,
	SwitchApplied,
	SwitchBaseline,
	SwitchEntryData,
	SwitchPlan,
	SystemPromptMode,
	ThinkingLevel,
} from "./src/types.js";

/** Custom entry type persisting a main-session switch (never sent to the model). */
const SWITCH_ENTRY_TYPE = "mx-pi-agents.switch";

/** Status key publishing the active main-session persona in the native footer. */
const STATUS_KEY = "mx-pi-agents";

const USAGE =
	"Usage: /mx-pi-agents [list | approve [name] | status | refresh]\n" +
	"  list     show the roster with mode, source, trust and pinned hash\n" +
	"  approve  review and approve gated (project/config) definitions\n" +
	"  status   show config path, roster counts, active and default persona\n" +
	"  refresh  re-pin the registry from disk (invalidates approvals on change)";

interface PersonasSettings {
	defaultPersona: string;
}

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

/**
 * Agent dir implied by the config store path: `<agentDir>/extensions/<file>`.
 * Falls back to pi's own resolution when the path does not have that shape.
 */
function agentDirFromPath(configPath: string): string {
	const marker = "/extensions/";
	const index = configPath.lastIndexOf(marker);
	if (index > 0) return configPath.slice(0, index);
	const dir = getAgentDir();
	if (dir.trim().length === 0) throw new Error("mx-pi-agents: could not resolve the agent directory");
	return dir;
}

export default function mxPiAgents(pi: ExtensionAPI) {
	const configStore = createConfigStore();
	const agentDir = agentDirFromPath(configStore.path);
	let config: AgentsConfig = defaultConfig();
	let roster: PinnedAgent[] = [];
	let diagnostics: AgentDiagnostic[] = [];

	/** Baseline captured before the first switch of the session; survives switches. */
	let baseline: SwitchBaseline | undefined;
	/** Active main-session switch, when one is applied. */
	let activeSwitch: { name: string; mode: SystemPromptMode; applied: SwitchApplied } | undefined;
	/** Guards the single auto-deactivation notification per switch. */
	let switchDeactivatedNotified = false;
	/** Latest `defaultPersona` value from the settings hub. */
	let defaultPersona = "";
	/** Session context for best-effort live settings re-application. */
	let sessionCtx: ExtensionContext | undefined;

	pi.registerFlag("mx-pi-agents-list", {
		type: "boolean",
		description: "Print the mx-pi-agents roster on startup",
	});
	pi.registerFlag("mx-pi-agents-disable", {
		type: "boolean",
		description: "Disable mx-pi-agents directives for this run",
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
		activeSwitch = { name: plan.name, mode: plan.mode, applied: plan.applied };
		switchDeactivatedNotified = false;
		try {
			ctx.ui.setStatus(STATUS_KEY, `${plan.mode}:${plan.name}`);
		} catch {
			/* ignore */
		}
		try {
			pi.appendEntry(SWITCH_ENTRY_TYPE, {
				name: plan.name,
				mode: plan.mode,
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
			ctx.ui.setStatus(STATUS_KEY, undefined);
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
			ctx.ui.setStatus(STATUS_KEY, undefined);
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
			activeSwitch = { name: decision.name, mode: decision.mode, applied: decision.applied };
			switchDeactivatedNotified = false;
			try {
				ctx.ui.setStatus(STATUS_KEY, `${decision.mode}:${decision.name}`);
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

	/**
	 * Trust gate. Interactive sessions may prompt; headless ones refuse. The
	 * approval is written back to the config file only after a confirmed yes.
	 */
	async function authorize(
		agent: PinnedAgent,
		ctx: ExtensionContext,
	): Promise<{ ok: true } | { ok: false; refusal: string }> {
		const decision = checkTrust(agent, {
			hasUI: ctx.hasUI,
			approvals: config.approvals,
			now: () => Date.now(),
		});
		if (decision.ok) return { ok: true };
		if (!decision.needsApproval) return { ok: false, refusal: decision.refusal };

		const request = approvalRequest(agent);
		const confirmed = await ctx.ui.confirm(
			"Apply a gated persona?",
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

	/**
	 * Verify the pinned hash, plan the switch fail-closed and apply it. Returns
	 * `true` when the switch was applied and `false` when it was refused.
	 */
	async function switchTo(agent: PinnedAgent, ctx: ExtensionContext): Promise<boolean> {
		const verified = verifyPinned(agent);
		if (!verified.ok) {
			ctx.ui.notify(`mx-pi-agents: ${verified.message}`, "warning");
			return false;
		}
		const planned = planSwitch(agent, {
			availableTools: mainToolNames(),
			isModelAvailable: (label) => modelAvailable(ctx, label),
		});
		if (!planned.ok) {
			ctx.ui.notify(`mx-pi-agents: ${planned.refusal}`, "warning");
			return false;
		}
		await applySwitchPlan(ctx, planned.plan);
		return true;
	}

	/**
	 * Apply the configured `defaultPersona` at session start. Empty means plain
	 * pi; an unknown name notifies and stays plain; a gated name runs the
	 * approval flow.
	 */
	async function applyDefaultPersona(ctx: ExtensionContext): Promise<void> {
		const name = defaultPersona.trim();
		if (name.length === 0) return;
		const agent = roster.find((candidate) => candidate.definition.name === name);
		if (agent === undefined) {
			ctx.ui.notify(`mx-pi-agents: default persona "#${name}" is unknown; staying on plain pi.`, "warning");
			return;
		}
		const decision = await authorize(agent, ctx);
		if (!decision.ok) {
			if (decision.refusal.length > 0) ctx.ui.notify(`mx-pi-agents: ${decision.refusal}`, "warning");
			return;
		}
		if (await switchTo(agent, ctx)) {
			ctx.ui.notify(
				`mx-pi-agents: ${formatSwitchNotice(agent.definition.name, agent.definition.systemPrompt)}`,
				"info",
			);
		}
	}

	// The settings hub controls `defaultPersona`. The handle is read at session
	// start so a stored value applies even when the hub never calls `onChange`;
	// the callback re-applies a live edit when a session already exists.
	const settings = registerSettings<PersonasSettings>(pi, {
		id: "mx-pi-agents",
		title: "Agents",
		description: "Default main-session persona applied at session start.",
		fields: [
			{
				key: "defaultPersona",
				label: "Default persona",
				description: "Name of the agent definition to apply at session start.",
				type: "string",
				default: "",
				placeholder: "e.g. socrates",
				maxLength: 64,
			},
		],
		onChange(values) {
			defaultPersona = values.defaultPersona;
			if (sessionCtx !== undefined) void applyDefaultPersona(sessionCtx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		try {
			defaultPersona = settings.get("defaultPersona");
		} catch {
			defaultPersona = "";
		}
		pin(ctx);
		await rehydrateSwitch(ctx);
		if (activeSwitch === undefined) await applyDefaultPersona(ctx);
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

	// Re-derived on every turn so the prompt is exact even after a resume, and
	// re-hashed so a mid-session edit deactivates the switch.
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
			if (agent.definition.systemPrompt === "replace") {
				options.customPrompt = agent.definition.body;
			} else {
				options.appendSystemPrompt = [options.appendSystemPrompt, agent.definition.body]
					.filter((part) => part.length > 0)
					.join("\n\n");
			}
			// Narrow the loaded resources to the definition's allow-lists. Absent
			// fields stay untouched; `[]` empties the section. pi has no unload call,
			// so this is the only enforcement point for a live switch.
			if (agent.definition.skills !== undefined) {
				options.skills = filterSkills(options.skills, agent.definition.skills);
			}
			if (agent.definition.contextFiles !== undefined) {
				options.contextFiles = filterContextFiles(options.contextFiles, agent.definition.contextFiles, ctx.cwd);
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
			const known = roster.some((candidate) => candidate.definition.name === directive.name);
			const dispatch = dispatchDirective({
				name: directive.name,
				known,
				hasTask: directive.task !== undefined,
			});

			if (dispatch.action === "refuse") {
				ctx.ui.notify(`mx-pi-agents: ${dispatch.message}`, "warning");
				return { action: "handled" as const };
			}
			if (dispatch.action === "reset") {
				await resetSwitch(ctx);
				ctx.ui.notify(`mx-pi-agents: ${formatSwitchNotice("", "base")}`, "info");
				return { action: "handled" as const };
			}

			const agent = roster.find((candidate) => candidate.definition.name === directive.name);
			if (agent === undefined) {
				ctx.ui.notify(`mx-pi-agents: unknown agent "#${directive.name}".`, "warning");
				return { action: "handled" as const };
			}
			const decision = await authorize(agent, ctx);
			if (!decision.ok) {
				const refusal =
					decision.refusal.length > 0 ? decision.refusal : `"${agent.definition.name}" was not approved.`;
				ctx.ui.notify(`mx-pi-agents: ${refusal}`, "warning");
				return { action: "handled" as const };
			}
			if (!(await switchTo(agent, ctx))) return { action: "handled" as const };
			if (directive.task !== undefined) {
				// The switch is applied before this same turn's before_agent_start, so
				// the task runs under the new persona.
				return { action: "transform" as const, text: directive.task };
			}
			ctx.ui.notify(
				`mx-pi-agents: ${formatSwitchNotice(agent.definition.name, agent.definition.systemPrompt)}`,
				"info",
			);
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
				case "":
				case "list": {
					ctx.ui.notify(renderRosterLines(rosterEntries(roster), ctx.ui.theme).join("\n"), "info");
					return;
				}

				case "status": {
					const active = activeSwitch !== undefined ? `${activeSwitch.mode}:${activeSwitch.name}` : "(none)";
					const lines = [
						`config: ${configStore.path}`,
						`agents: ${roster.length} (${gatedAgents(roster).length} gated)`,
						`agentPaths: ${config.agentPaths.length > 0 ? config.agentPaths.join(", ") : "(none)"}`,
						`bundled: ${bundledAgentsDir()}`,
						`active persona: ${active}`,
						`default persona: ${defaultPersona.trim().length > 0 ? defaultPersona.trim() : "(none)"}`,
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

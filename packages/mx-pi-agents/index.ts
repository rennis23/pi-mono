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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentsConfig, createConfigStore } from "./src/config.js";
import { type DelegationStep, type OrchestratorDeps, runChain, runParallel, runSingle } from "./src/modes.js";
import { aggregateResults, createRedactor, DEFAULT_PER_RESULT_BYTES, DEFAULT_TOTAL_BYTES } from "./src/output.js";
import { describeRefusal } from "./src/policy.js";
import { bundledAgentsDir, discoverAgents, type RegistryDirs, rosterEntries } from "./src/registry.js";
import {
	type AgentToolDetails,
	renderCallLines,
	renderDiagnostics,
	renderResultLines,
	renderRosterLines,
} from "./src/render.js";
import { type RunnerRegistry, selectRunner, unavailableRunner } from "./src/runner.js";
import { createInProcessRunner } from "./src/runners/in-process.js";
import { isSandboxAvailable } from "./src/runners/sandbox.js";
import { CHILD_ENV_MARKER, createSubprocessRunner } from "./src/runners/subprocess.js";
import { approvalRequest, checkTrust, gatedAgents, recordApproval, withApprovals } from "./src/trust.js";
import { type AgentDiagnostic, type PinnedAgent, type RunPlan, type RunResult, zeroUsage } from "./src/types.js";

const CHILD_MARKER_VALUE = "1";
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
	let config: AgentsConfig = { version: 1, agentPaths: [], approvals: {}, limits: {} };
	let roster: PinnedAgent[] = [];
	let diagnostics: AgentDiagnostic[] = [];

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

	pi.on("session_start", async (_event, ctx) => {
		pin(ctx);
		for (const diagnostic of diagnostics) {
			if (diagnostic.level === "warning") ctx.ui.notify(`mx-pi-agents: ${diagnostic.message}`, "warning");
		}
		if (pi.getFlag("mx-pi-agents-list") === true) {
			ctx.ui.notify(renderRosterLines(rosterEntries(roster), ctx.ui.theme).join("\n"), "info");
		}
	});

	pi.registerTool({
		name: "mx_pi_agent",
		label: "mx_pi_agent",
		description: [
			"Delegate a task to a named agent with an explicit capability grant.",
			"Modes: single ({agent, task}), parallel ({tasks: [...]}, max 8), chain ({chain: [...]}, {previous} substitution).",
			"Agents come from the pinned registry; project agents require approval.",
		].join(" "),
		parameters: DEFAULT_PARAMS,
		executionMode: "parallel",

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
			const orchestration = deps(ctx);
			// The trust gate is async, so authorize up front for every distinct agent.
			const names = [...new Set(steps.map((step) => step.agent))];
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

			const progress = (results: RunResult[]) => {
				onUpdate?.({
					content: [{ type: "text", text: `${results.length}/${steps.length} step(s) settled` }],
					details: {
						mode,
						results,
						diagnostics: orchestration.context.limits ? [] : [],
						refusalReason: undefined,
					} satisfies AgentToolDetails,
				});
			};
			const options = {
				signal: abort,
				now: () => Date.now(),
				onUpdate: (partial: RunResult) => progress([partial]),
			};

			const outcome =
				mode === "parallel"
					? await runParallel(steps, orchestration, options)
					: mode === "chain"
						? await runChain(steps, orchestration, options)
						: await runSingle(steps[0], orchestration, options);

			const redact = createRedactor(process.env);
			const capped = aggregateResults(outcome.results, {
				perResultBytes: DEFAULT_PER_RESULT_BYTES,
				totalBytes: DEFAULT_TOTAL_BYTES,
			});
			// A refusal that happened before any session exists has no results to
			// render, so the refusal text itself is the whole tool result.
			const refusalText = outcome.refusal !== undefined ? describeRefusal(outcome.refusal) : "";
			const text = redact(capped.text.length > 0 ? capped.text : refusalText);
			const details: AgentToolDetails = {
				mode: outcome.mode,
				results: outcome.results,
				diagnostics: outcome.diagnostics,
				refusalReason: outcome.refusal?.message,
			};

			const failed = outcome.results.some((result) => !result.ok);
			return {
				content: [{ type: "text" as const, text: text.length > 0 ? text : "(no output)" }],
				details,
				...(failed || outcome.refusal !== undefined ? { isError: true } : {}),
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
					const lines = [
						`config: ${configStore.path}`,
						`agents: ${roster.length} (${gatedAgents(roster).length} gated)`,
						`agentPaths: ${config.agentPaths.length > 0 ? config.agentPaths.join(", ") : "(none)"}`,
						`bundled: ${bundledAgentsDir()}`,
						`limits: ${JSON.stringify(config.limits)}`,
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

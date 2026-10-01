/**
 * Policy: turn a pinned definition plus session context into a `RunPlan`, or a
 * refusal.
 *
 * This is the single place where capability decisions are made, and it is
 * total: every error path either drops a tool with a diagnostic or refuses the
 * run. There is no branch that yields "everything" as a fallback — an empty
 * grant set always becomes `noTools: "all"`.
 */

import { resolveBudgets } from "./budget.js";
import { assemblePlanPrompt } from "./prompt.js";
import { computeEffectiveTools } from "./schema.js";
import { describeScope, isUnconfineable, resolveScope } from "./scope.js";
import type { AgentDiagnostic, Budgets, PinnedAgent, PlanOutcome, Refusal, RefusalReason, RunPlan } from "./types.js";

/** Session facts the policy needs. None of them come from the target repo. */
export interface SessionContext {
	/** Working directory for the child (the parent's cwd). */
	cwd: string;
	/** Tool names active in the parent session, used for inheritance. */
	parentTools: readonly string[];
	/** Tool names that will resolve inside the child. */
	availableTools: readonly string[];
	/** Config ceilings that bound agent-declared budgets. */
	limits: Partial<Budgets>;
	/** Config scope ceiling; absent means `[cwd]`. */
	scopeCeiling?: readonly string[];
	/** Whether `sandbox: os` is available on this platform. */
	sandboxAvailable: boolean;
	/** Whether the resolved model exists and has credentials. */
	isModelAvailable: (model: string) => boolean;
	/** Spawn-capable names excluded from inheritance. */
	spawnToolNames?: readonly string[];
}

function refuse(reason: RefusalReason, message: string, diagnostics: AgentDiagnostic[] = []): PlanOutcome {
	return { ok: false, refusal: { reason, message, diagnostics } };
}

/**
 * Compute a run plan for `agent`, or refuse.
 *
 * Order of checks (first failure wins, so the message names the real cause):
 * 1. spawn-capable tools may never be granted (`spawn-tool-grant`) — checked first
 *    because recursion is a structural problem, not a resolution problem
 * 2. explicit grants must resolve in the child (`unresolved-tool`)
 * 3. the effective path scope must resolve and be enforceable (`scope-invalid` /
 *    `scope-unenforceable`)
 * 4. a declared model must resolve (`model-unavailable`)
 * 5. `sandbox: os` requires a backend (`sandbox-unavailable`)
 */
export function planRun(agent: PinnedAgent, task: string, ctx: SessionContext): PlanOutcome {
	const diagnostics: AgentDiagnostic[] = [];
	const definition = agent.definition;

	// A persona only ever runs in the main session; refusing here means no child
	// session is created for the tool, parallel, chain or pipeline paths alike
	// (security invariant 14).
	if (definition.kind === "persona") {
		return refuse(
			"persona-child",
			`agent "${definition.name}" is a persona agent: it can only run in the main session`,
			diagnostics,
		);
	}

	const grants = computeEffectiveTools(definition, {
		parentTools: ctx.parentTools,
		availableTools: ctx.availableTools,
		spawnToolNames: ctx.spawnToolNames,
	});
	diagnostics.push(...grants.diagnostics);

	const spawn = new Set(ctx.spawnToolNames ?? ["mx_pi_agent", "subagent", "spawn_subagent", "subagent_task", "Task"]);
	const spawnGranted = grants.tools.filter((name) => spawn.has(name));
	if (spawnGranted.length > 0) {
		return refuse(
			"spawn-tool-grant",
			`agent "${definition.name}" grants spawn-capable tools, which would allow unbounded recursion: ${spawnGranted.join(", ")}`,
			diagnostics,
		);
	}

	if (grants.unresolvedExplicit.length > 0) {
		return refuse(
			"unresolved-tool",
			`agent "${definition.name}" grants tools that do not resolve in the child: ${grants.unresolvedExplicit.join(", ")}`,
			diagnostics,
		);
	}

	const scope = resolveScope({
		definitionScope: definition.scope,
		ceiling: ctx.scopeCeiling,
		cwd: ctx.cwd,
		vector: { isolation: definition.isolation, sandbox: definition.sandbox, tools: grants.tools },
	});
	if (!scope.ok) {
		return refuse(scope.reason, `agent "${definition.name}" ${scope.message}`, diagnostics);
	}
	if (isUnconfineable({ isolation: definition.isolation, sandbox: definition.sandbox, tools: grants.tools })) {
		diagnostics.push({
			level: "info",
			message: `run is unconfined (an explicit "/" ceiling licensed ${definition.isolation === "subprocess" ? "isolation: subprocess" : "unsandboxed bash"})`,
		});
	}

	if (definition.model !== undefined && !ctx.isModelAvailable(definition.model)) {
		return refuse(
			"model-unavailable",
			`agent "${definition.name}" declares model "${definition.model}", which is not available with configured credentials`,
			diagnostics,
		);
	}

	if (definition.sandbox === "os" && !ctx.sandboxAvailable) {
		return refuse(
			"sandbox-unavailable",
			`agent "${definition.name}" requires sandbox: os, but no supported sandbox backend is available on this platform`,
			diagnostics,
		);
	}

	if (task.trim().length === 0) {
		return refuse("invalid-request", "task must not be empty", diagnostics);
	}

	const budgets = resolveBudgets(
		{
			maxTurns: definition.maxTurns,
			timeoutMs: definition.timeoutMs,
			tokenBudget: definition.tokenBudget,
			costBudget: definition.costBudget,
		},
		ctx.limits,
	);

	const prompt = assemblePlanPrompt({ agentName: definition.name, tools: grants.tools }, definition.body);
	diagnostics.push(...prompt.diagnostics);

	const plan: RunPlan = {
		agentName: definition.name,
		source: agent.source,
		task,
		tools: grants.tools,
		noTools: grants.noTools,
		model: definition.model,
		thinking: definition.thinking,
		systemPrompt: prompt.systemPrompt,
		budgets,
		isolation: definition.isolation,
		sandbox: definition.sandbox,
		cwd: ctx.cwd,
		scope: { roots: scope.roots, unrestricted: scope.unrestricted },
		diagnostics,
	};

	return { ok: true, plan };
}

/** Human-readable one-liner describing a refusal, for a tool result. */
export function describeRefusal(refusal: Refusal): string {
	const lines = [`Refused (${refusal.reason}): ${refusal.message}`];
	for (const diagnostic of refusal.diagnostics) {
		lines.push(`- ${diagnostic.level}: ${diagnostic.message}`);
	}
	return lines.join("\n");
}

/** Compact one-line summary of a plan's effective capabilities. */
export function describePlan(plan: RunPlan): string {
	const tools = plan.tools.length === 0 ? "none" : plan.tools.join(",");
	return `${plan.agentName} [${plan.source.kind}] tools=${tools} isolation=${plan.isolation} scope=${describeScope(plan.scope.roots, plan.scope.unrestricted, plan.cwd)} turns=${plan.budgets.maxTurns} timeout=${plan.budgets.timeoutMs}ms tokens=${plan.budgets.tokenBudget}`;
}

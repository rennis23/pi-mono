/**
 * Trust and approval.
 *
 * Trusted sources (bundled, global) apply without a gate. Gated sources (config
 * `agentPaths`, project `.pi/agents`) require an explicit approval whose hash
 * matches the current file. There is no "approve this directory" mode: an edit
 * invalidates the approval and the next switch refuses until re-approved.
 *
 * Headless sessions (no dialog UI) never prompt; they apply a gated definition
 * only when a matching stored approval already exists. Everything else refuses.
 */

import { type AgentsConfig, APPROVAL_MAX_AGE_MS, type ApprovalEntry, type ApprovalLedger } from "./config.js";
import { sanitizeUiText } from "./security.js";
import { formatToolEntry } from "./tools.js";
import type { PinnedAgent } from "./types.js";

/** Outcome of the approval gate for one agent. */
export type TrustDecision =
	| { ok: true; alreadyApproved: boolean }
	| { ok: false; refusal: string; needsApproval: boolean };

/** A gated agent presented to the operator for approval. */
export interface ApprovalRequest {
	agent: PinnedAgent;
	/** Real directory the approval is keyed under. */
	directory: string;
	/** File name within that directory. */
	fileName: string;
	/** Human-readable confirm body (control-free). */
	summary: string;
}

export interface TrustContext {
	/** Whether dialog-capable UI is available (TUI/RPC). */
	hasUI: boolean;
	/** Approval ledger from the config file. */
	approvals: ApprovalLedger;
	/** Injected clock. */
	now: () => number;
}

function fileNameOf(path: string): string {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return index === -1 ? path : path.slice(index + 1);
}

/** Stored approval for a definition file, when present and unexpired. */
export function storedApproval(
	approvals: ApprovalLedger,
	directory: string,
	fileName: string,
	now: number,
): ApprovalEntry | undefined {
	const entry = approvals[directory]?.[fileName];
	if (!entry) return undefined;
	if (entry.approvedAt > 0 && now - entry.approvedAt > APPROVAL_MAX_AGE_MS) return undefined;
	return entry;
}

/** True when the stored approval matches the current file hash exactly. */
export function approvalMatches(entry: ApprovalEntry | undefined, hash: string): boolean {
	return entry !== undefined && entry.hash === hash;
}

/** One-line statement of what a gated definition would change in the main session. */
function mainPromptConsequence(agent: PinnedAgent): string {
	const name = sanitizeUiText(agent.definition.name, 64);
	const verb = agent.definition.systemPrompt === "replace" ? "replace" : "extend";
	return `"${name}" [${agent.definition.systemPrompt}] can ${verb} the main system prompt and change tools, model and thinking for this session.`;
}

/** Build the request shown to the operator, or used in a headless refusal. */
export function approvalRequest(agent: PinnedAgent): ApprovalRequest {
	const directory = agent.source.directory;
	const fileName = fileNameOf(agent.source.path);
	const name = sanitizeUiText(agent.definition.name, 64);
	const description = sanitizeUiText(agent.definition.description, 120);
	const tools = agent.definition.tools
		? sanitizeUiText(agent.definition.tools.map(formatToolEntry).join(", "), 200)
		: "(inherit rules)";
	const lines = [
		`Agent: ${name}`,
		`System prompt: ${agent.definition.systemPrompt}`,
		`Description: ${description}`,
		`Source: ${agent.source.kind} — ${sanitizeUiText(agent.source.path, 200)}`,
		`Hash: ${agent.hash.slice(0, 12)}`,
		`Tools: ${tools}`,
	];
	lines.push(mainPromptConsequence(agent));
	return {
		agent,
		directory,
		fileName,
		summary: lines.join("\n"),
	};
}

/**
 * Decide whether a gated agent may apply.
 *
 * - A matching stored approval always passes.
 * - Otherwise, an interactive session may prompt (returned as `needsApproval`);
 *   the caller shows the confirm and records the result.
 * - A headless session refuses with an `unapproved-project-agent` message.
 */
export function checkTrust(agent: PinnedAgent, ctx: TrustContext): TrustDecision {
	if (agent.source.trusted) return { ok: true, alreadyApproved: true };

	const request = approvalRequest(agent);
	const entry = storedApproval(ctx.approvals, request.directory, request.fileName, ctx.now());
	if (approvalMatches(entry, agent.hash)) return { ok: true, alreadyApproved: true };

	if (ctx.hasUI) return { ok: false, refusal: "", needsApproval: true };

	return {
		ok: false,
		needsApproval: false,
		refusal: `agent "${agent.definition.name}" is gated (${agent.source.kind}) and has no matching approval; run /mx-pi-agents approve in an interactive session first`,
	};
}

/** Record an approval into a ledger (pure; caller persists). */
export function recordApproval(approvals: ApprovalLedger, agent: PinnedAgent, now: number): ApprovalLedger {
	const request = approvalRequest(agent);
	const next: ApprovalLedger = { ...approvals };
	next[request.directory] = {
		...next[request.directory],
		[request.fileName]: { hash: agent.hash, kind: agent.source.kind, approvedAt: now },
	};
	return next;
}

/** Gated agents in a roster, in discovery order. */
export function gatedAgents(agents: readonly PinnedAgent[]): PinnedAgent[] {
	return agents.filter((agent) => !agent.source.trusted);
}

/** Apply an approval ledger to a config object (pure; caller persists). */
export function withApprovals(config: AgentsConfig, approvals: ApprovalLedger): AgentsConfig {
	return { ...config, approvals };
}

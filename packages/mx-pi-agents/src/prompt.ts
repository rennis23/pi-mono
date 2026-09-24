/**
 * Child system prompt assembly.
 *
 * The child prompt is exactly two parts: a fixed runtime header (no project
 * content, no paths that the model could turn into a resource request) and the
 * definition body. Nothing from the target repository is ever concatenated in,
 * which is what makes a hostile `.pi/skills/**` unable to reach the child
 * system prompt.
 */

import { stripControlChars } from "./security.js";
import type { AgentDiagnostic, RunPlan } from "./types.js";

/** Cap on the assembled child system prompt, in UTF-8 bytes. */
export const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;

/** Fixed header prepended to every child system prompt. */
export const RUNTIME_HEADER = [
	"You are a subagent invoked by another pi session.",
	"Work only on the task you were given; report findings concisely.",
	"You cannot delegate to further agents.",
].join("\n");

export interface PromptInput {
	agentName: string;
	/** Capability grants, already computed. */
	tools: readonly string[];
	/** True when the grant set is empty (the child has no tools at all). */
	noTools: boolean;
}

/**
 * Build the fixed runtime header. Deliberately excludes the working directory,
 * repository name, and any other attacker-influenced string: the model gets
 * capability facts, not filesystem paths it could be talked into reading.
 */
export function buildRuntimeHeader(input: PromptInput): string {
	const lines = [RUNTIME_HEADER, ""];
	lines.push(`Agent: ${input.agentName}`);
	lines.push(
		input.noTools
			? "Available tools: none. You cannot read files, run commands, or write anything; answer from your own knowledge and the task text."
			: `Available tools: ${input.tools.join(", ")}. Use only these; do not assume others exist.`,
	);
	return lines.join("\n");
}

/** Truncate a UTF-8 string to at most `maxBytes` without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let slice = text.slice(0, maxBytes);
	while (slice.length > 0 && Buffer.byteLength(slice, "utf8") > maxBytes) slice = slice.slice(0, -1);
	return slice;
}

export interface PromptAssembly {
	systemPrompt: string;
	diagnostics: AgentDiagnostic[];
	truncated: boolean;
}

/**
 * Assemble the child system prompt: runtime header, a separator, then the
 * definition body. Control characters are stripped from the body so a
 * definition cannot smuggle terminal escapes into a rendered prompt, and the
 * whole prompt is capped by `MAX_SYSTEM_PROMPT_BYTES`.
 */
export function assembleSystemPrompt(body: string, input: PromptInput): PromptAssembly {
	const diagnostics: AgentDiagnostic[] = [];
	const safeBody = stripControlChars(body, { keepNewlines: true }).trim();
	const header = buildRuntimeHeader(input);
	let systemPrompt = safeBody.length > 0 ? `${header}\n\n${safeBody}` : header;

	let truncated = false;
	if (Buffer.byteLength(systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_BYTES) {
		truncated = true;
		systemPrompt = `${truncateUtf8(systemPrompt, MAX_SYSTEM_PROMPT_BYTES)}\n\n[definition body truncated]`;
		diagnostics.push({
			level: "warning",
			message: `definition body exceeded ${MAX_SYSTEM_PROMPT_BYTES} bytes and was truncated`,
		});
	}

	return { systemPrompt, diagnostics, truncated };
}

/** Convenience wrapper used by the policy layer once grants are known. */
export function assemblePlanPrompt(plan: Pick<RunPlan, "agentName" | "tools">, body: string): PromptAssembly {
	return assembleSystemPrompt(body, {
		agentName: plan.agentName,
		tools: plan.tools,
		noTools: plan.tools.length === 0,
	});
}

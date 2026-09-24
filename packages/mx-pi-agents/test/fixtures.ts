/**
 * Fixtures shared by the pure-logic tests.
 *
 * `makeAgent` writes a real definition file to a temp directory and returns a
 * `PinnedAgent` whose hash matches it. That matters: `verifyPinned` re-reads and
 * re-hashes at spawn time, so a fixture that only existed in memory would make
 * every run refuse. Tests that want a refusal mutate the file afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { SessionContext } from "../src/policy.js";
import { sha256Hex } from "../src/security.js";
import type { AgentDefinition, PinnedAgent, SourceKind } from "../src/types.js";

const created: string[] = [];

/** Temp dirs made by `makeAgent`; removed automatically after each test. */
export function cleanupFixtureDirs(): void {
	for (const dir of created.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

afterEach(cleanupFixtureDirs);

export interface MakeAgentOptions {
	name?: string;
	description?: string;
	tools?: string[] | undefined;
	toolsInheritance?: AgentDefinition["toolsInheritance"];
	model?: string;
	thinking?: AgentDefinition["thinking"];
	maxTurns?: number;
	timeoutMs?: number;
	tokenBudget?: number;
	costBudget?: number;
	isolation?: AgentDefinition["isolation"];
	sandbox?: AgentDefinition["sandbox"];
	body?: string;
	kind?: SourceKind;
	/** Extra frontmatter lines appended verbatim (used for hostile cases). */
	extraFrontmatter?: string;
}

function frontmatterFor(options: MakeAgentOptions, name: string): string {
	const lines = [`name: ${name}`, `description: ${options.description ?? `${name} description`}`];
	if (options.tools !== undefined) lines.push(`tools: [${options.tools.join(", ")}]`);
	if (options.toolsInheritance !== undefined) lines.push(`tools_inheritance: ${options.toolsInheritance}`);
	if (options.model !== undefined) lines.push(`model: ${options.model}`);
	if (options.thinking !== undefined) lines.push(`thinking: ${options.thinking}`);
	if (options.maxTurns !== undefined) lines.push(`max_turns: ${options.maxTurns}`);
	if (options.timeoutMs !== undefined) lines.push(`timeout_ms: ${options.timeoutMs}`);
	if (options.tokenBudget !== undefined) lines.push(`token_budget: ${options.tokenBudget}`);
	if (options.costBudget !== undefined) lines.push(`cost_budget: ${options.costBudget}`);
	if (options.isolation !== undefined) lines.push(`isolation: ${options.isolation}`);
	if (options.sandbox !== undefined) lines.push(`sandbox: ${options.sandbox}`);
	if (options.extraFrontmatter !== undefined) lines.push(options.extraFrontmatter);
	return lines.join("\n");
}

/**
 * Write a definition file to a fresh temp directory and return its pinned
 * record. The definition body defaults to a short deterministic sentence.
 */
export function makeAgent(options: MakeAgentOptions = {}): PinnedAgent {
	const name = options.name ?? "explorer";
	const kind = options.kind ?? "global";
	const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-fixture-"));
	created.push(dir);

	const body = options.body ?? `You are ${name}. Do the task.`;
	const path = join(dir, `${name}.md`);
	const content = `---\n${frontmatterFor(options, name)}\n---\n\n${body}\n`;
	writeFileSync(path, content);

	const definition: AgentDefinition = {
		name,
		description: options.description ?? `${name} description`,
		tools: options.tools,
		toolsInheritance: options.toolsInheritance ?? "none",
		model: options.model,
		thinking: options.thinking,
		maxTurns: options.maxTurns,
		timeoutMs: options.timeoutMs,
		tokenBudget: options.tokenBudget,
		costBudget: options.costBudget,
		isolation: options.isolation ?? "process",
		sandbox: options.sandbox ?? "none",
		body,
	};

	return {
		definition,
		source: { kind, path, directory: dir, trusted: kind === "bundled" || kind === "global" },
		hash: sha256Hex(content),
		pinnedAt: 1000,
	};
}

/** Overwrite a fixture's file so the pinned hash no longer matches. */
export function mutateAgentFile(agent: PinnedAgent, content: string): void {
	writeFileSync(agent.source.path, content);
}

/** Session context with sensible defaults for policy/mode tests. */
export function makeSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
	return {
		cwd: "/work",
		parentTools: ["read", "grep", "bash", "mx_pi_agent"],
		availableTools: ["read", "grep", "bash", "write", "mx_pi_agent"],
		limits: {},
		sandboxAvailable: true,
		isModelAvailable: () => true,
		...overrides,
	};
}

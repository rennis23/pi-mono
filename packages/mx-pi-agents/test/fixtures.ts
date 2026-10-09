/**
 * Fixtures shared by the pure-logic tests.
 *
 * `makeAgent` writes a real definition file to a temp directory and returns a
 * `PinnedAgent` whose hash matches it. That matters: `verifyPinned` re-reads and
 * re-hashes before a switch, so a fixture that only existed in memory would make
 * every verification fail. Tests that want a refusal mutate the file afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { sha256Hex } from "../src/security.js";
import { parseToolEntry } from "../src/tools.js";
import type { AgentDefinition, PinnedAgent, SourceKind, SystemPromptMode } from "../src/types.js";

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
	/** Tool entries as written in the frontmatter, e.g. `["read"]` or `["+codemode", "-write"]`. */
	tools?: string[] | undefined;
	skills?: string[] | undefined;
	contextFiles?: string[] | undefined;
	model?: string;
	thinking?: AgentDefinition["thinking"];
	/** System prompt mode; defaults to `append`. */
	systemPrompt?: SystemPromptMode;
	body?: string;
	/** Provenance of the definition; not the system prompt mode. */
	sourceKind?: SourceKind;
	/** Extra frontmatter lines appended verbatim (used for hostile cases). */
	extraFrontmatter?: string;
}

function frontmatterFor(options: MakeAgentOptions, name: string): string {
	const lines = [`name: ${name}`, `description: ${options.description ?? `${name} description`}`];
	if (options.systemPrompt !== undefined) lines.push(`system_prompt: ${options.systemPrompt}`);
	if (options.tools !== undefined) lines.push(`tools: [${options.tools.join(", ")}]`);
	if (options.skills !== undefined) lines.push(`skills: [${options.skills.join(", ")}]`);
	if (options.contextFiles !== undefined) lines.push(`context_files: [${options.contextFiles.join(", ")}]`);
	if (options.model !== undefined) lines.push(`model: ${options.model}`);
	if (options.thinking !== undefined) lines.push(`thinking: ${options.thinking}`);
	if (options.extraFrontmatter !== undefined) lines.push(options.extraFrontmatter);
	return lines.join("\n");
}

/**
 * Write a definition file to a fresh temp directory and return its pinned
 * record. The definition body defaults to a short deterministic sentence.
 */
export function makeAgent(options: MakeAgentOptions = {}): PinnedAgent {
	const name = options.name ?? "explorer";
	const kind = options.sourceKind ?? "global";
	const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-fixture-"));
	created.push(dir);

	const body = options.body ?? `You are ${name}. Do the task.`;
	const path = join(dir, `${name}.md`);
	const content = `---\n${frontmatterFor(options, name)}\n---\n\n${body}\n`;
	writeFileSync(path, content);

	const definition: AgentDefinition = {
		name,
		description: options.description ?? `${name} description`,
		systemPrompt: options.systemPrompt ?? "append",
		tools: options.tools?.map((raw) => parseToolEntry(raw) ?? { op: "plain", name: raw.trim() }),
		skills: options.skills,
		contextFiles: options.contextFiles,
		model: options.model,
		thinking: options.thinking,
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

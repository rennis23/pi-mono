/**
 * Agent registry: discovery, precedence, and pinning.
 *
 * Definitions are read once at `session_start`, hashed, and stored as
 * `PinnedAgent` records. Nothing later in the session re-reads the disk for
 * decisions — only `verifyPinned` does, and that is a pure re-hash comparison.
 * This is what makes a mid-session edit of a definition unable to change a run.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentDefinition } from "./schema.js";
import { sanitizeUiText, sha256Hex } from "./security.js";
import type { AgentDiagnostic, AgentSource, PinnedAgent, RegistrySnapshot, SourceKind } from "./types.js";

/** Discovery precedence, lowest to highest. Gated kinds may never shadow trusted ones. */
export const SOURCE_ORDER: readonly SourceKind[] = ["bundled", "global", "config", "project"];

export function isTrustedKind(kind: SourceKind): boolean {
	return kind === "bundled" || kind === "global";
}

/**
 * Directory holding the package's bundled agents.
 *
 * Resolved relative to this module rather than via pi's `getPackageDir()`,
 * which points at the pi-coding-agent package itself. `import.meta.url` works
 * for both the source checkout (`src/registry.ts` → `../agents`) and a
 * published copy, where the file list ships `agents/**` next to `index.ts`.
 */
export function bundledAgentsDir(): string {
	return fileURLToPath(new URL("../agents", import.meta.url));
}

/** Global agent directory (`<agentDir>/agents`). */
export function globalAgentsDir(agentDir: string): string {
	return join(agentDir, "agents");
}

/** Project agent directory (`<cwd>/.pi/agents`). */
export function projectAgentsDir(cwd: string): string {
	return join(cwd, ".pi", "agents");
}

export interface RegistryDirs {
	agentDir: string;
	cwd: string;
	/** Extra gated directories from the config, in config order. */
	agentPaths: readonly string[];
	/**
	 * Override for the bundled agents directory. Tests point this at an empty
	 * temp dir so the shipped `agents/*.md` do not leak into assertions; the
	 * default resolves next to this module.
	 */
	bundledDir?: string;
}

/** Every directory to scan, in discovery order. */
export function discoveryDirs(dirs: RegistryDirs): Array<{ kind: SourceKind; directory: string }> {
	const out: Array<{ kind: SourceKind; directory: string }> = [
		{ kind: "bundled", directory: dirs.bundledDir ?? bundledAgentsDir() },
		{ kind: "global", directory: globalAgentsDir(dirs.agentDir) },
	];
	for (const path of dirs.agentPaths) out.push({ kind: "config", directory: path });
	out.push({ kind: "project", directory: projectAgentsDir(dirs.cwd) });
	return out;
}

/** Definition files directly inside `directory` (`*.md`), sorted by name. */
function listDefinitionFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(directory);
	} catch {
		return [];
	}
	if (!stats.isDirectory()) return [];
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return [];
	}
	return entries
		.filter((name) => name.toLowerCase().endsWith(".md") && !name.startsWith("."))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map((name) => join(directory, name));
}

/** One discovered file, before precedence resolution. */
interface Candidate {
	kind: SourceKind;
	directory: string;
	path: string;
	hash: string;
	content: string;
}

function readCandidate(kind: SourceKind, directory: string, path: string): Candidate | undefined {
	try {
		const content = readFileSync(path, "utf8");
		return { kind, directory, path, hash: sha256Hex(content), content };
	} catch {
		return undefined;
	}
}

/** Discovery plus resolution result. */
export interface DiscoveryResult {
	agents: PinnedAgent[];
	diagnostics: AgentDiagnostic[];
	/** Gated definitions that were dropped because a trusted name shadows them. */
	shadowed: Array<{ name: string; path: string; shadowedBy: string }>;
}

/**
 * Discover every definition and resolve precedence.
 *
 * Rules:
 * - Later sources override earlier ones **only** within the same trust class;
 *   a gated definition that would shadow a trusted name is dropped with a
 *   diagnostic (no silent override).
 * - The first file (in discovery order) that declares a name wins within a
 *   class; later duplicates are dropped with a diagnostic.
 * - A file that fails to parse is dropped with a diagnostic; it never falls
 *   back to a permissive default.
 */
export function discoverAgents(dirs: RegistryDirs, now: () => number): DiscoveryResult {
	const diagnostics: AgentDiagnostic[] = [];
	const shadowed: DiscoveryResult["shadowed"] = [];
	const byName = new Map<
		string,
		{ candidate: Candidate; source: AgentSource; definition: PinnedAgent["definition"] }
	>();

	for (const { kind, directory } of discoveryDirs(dirs)) {
		for (const path of listDefinitionFiles(directory)) {
			const candidate = readCandidate(kind, directory, path);
			if (!candidate) {
				diagnostics.push({ level: "warning", message: "could not read definition file", path });
				continue;
			}
			const parsed = parseAgentDefinition(candidate.content);
			if (!parsed.ok) {
				diagnostics.push({ level: "warning", message: `dropped definition: ${parsed.error}`, path });
				continue;
			}
			const name = parsed.definition.name;
			const existing = byName.get(name);

			if (existing) {
				const existingTrusted = isTrustedKind(existing.source.kind);
				const candidateTrusted = isTrustedKind(kind);
				if (existingTrusted && !candidateTrusted) {
					// A gated definition never shadows a trusted name. Discovery order
					// already puts trusted sources first, so this is the shadow case.
					shadowed.push({ name, path, shadowedBy: existing.source.path });
					diagnostics.push({
						level: "warning",
						message: `gated definition "${name}" was dropped: it would shadow the trusted definition at ${existing.source.path}`,
						path,
					});
					continue;
				}
				// Same trust class (or two gated sources): the first one discovered wins.
				diagnostics.push({
					level: "info",
					message: `duplicate definition "${name}" was dropped in favour of ${existing.source.path}`,
					path,
				});
				continue;
			}

			const real = realDirectoryOf(candidate.path);
			byName.set(name, {
				candidate,
				source: {
					kind,
					path: candidate.path,
					directory: real,
					trusted: isTrustedKind(kind),
				},
				definition: parsed.definition,
			});
		}
	}

	const pinnedAt = now();
	const agents: PinnedAgent[] = [...byName.values()]
		.sort((a, b) => (a.definition.name < b.definition.name ? -1 : 1))
		.map(({ candidate, source, definition }) => ({
			definition,
			source,
			hash: candidate.hash,
			pinnedAt,
		}));

	return { agents, diagnostics, shadowed };
}

/** Real directory of a definition file, resolved through symlinks. */
export function realDirectoryOf(filePath: string): string {
	try {
		return realpathSync(join(filePath, ".."));
	} catch {
		return join(filePath, "..");
	}
}

/** Pin the registry for one session. */
export function pinRegistry(
	dirs: RegistryDirs,
	now: () => number,
): {
	snapshot: RegistrySnapshot;
	shadowed: DiscoveryResult["shadowed"];
} {
	const discovery = discoverAgents(dirs, now);
	return {
		snapshot: {
			agents: discovery.agents,
			diagnostics: discovery.diagnostics,
			pinnedAt: discovery.agents[0]?.pinnedAt ?? now(),
		},
		shadowed: discovery.shadowed,
	};
}

export type VerifyResult = { ok: true; hash: string } | { ok: false; reason: "missing" | "changed"; message: string };

/**
 * Re-read and re-hash a pinned definition at spawn time. A missing file or a
 * changed hash refuses the run: the pinned body must be exactly what was
 * approved and reviewed.
 */
export function verifyPinned(agent: PinnedAgent): VerifyResult {
	let content: string;
	try {
		content = readFileSync(agent.source.path, "utf8");
	} catch {
		return {
			ok: false,
			reason: "missing",
			message: `definition file is no longer readable: ${agent.source.path}`,
		};
	}
	const hash = sha256Hex(content);
	if (hash !== agent.hash) {
		return {
			ok: false,
			reason: "changed",
			message: `definition changed since session start: ${agent.source.path} (pinned ${agent.hash.slice(0, 12)}, now ${hash.slice(0, 12)})`,
		};
	}
	return { ok: true, hash };
}

/** One roster line for `/mx-pi-agents list`, already sanitized for display. */
export interface RosterEntry {
	name: string;
	description: string;
	source: SourceKind;
	path: string;
	trusted: boolean;
	hash: string;
	tools: string | undefined;
	isolation: string;
	sandbox: string;
	model: string | undefined;
}

export function rosterEntries(agents: readonly PinnedAgent[]): RosterEntry[] {
	return agents.map((agent) => ({
		name: sanitizeUiText(agent.definition.name, 64),
		description: sanitizeUiText(agent.definition.description, 120),
		source: agent.source.kind,
		path: sanitizeUiText(agent.source.path, 200),
		trusted: agent.source.trusted,
		hash: agent.hash.slice(0, 12),
		tools: agent.definition.tools ? sanitizeUiText(agent.definition.tools.join(","), 200) : undefined,
		isolation: agent.definition.isolation,
		sandbox: agent.definition.sandbox,
		model: agent.definition.model ? sanitizeUiText(agent.definition.model, 80) : undefined,
	}));
}

/** Find a pinned agent by name. */
export function findAgent(agents: readonly PinnedAgent[], name: string): PinnedAgent | undefined {
	return agents.find((agent) => agent.definition.name === name);
}

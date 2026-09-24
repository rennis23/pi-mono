/**
 * OS-level sandbox wrappers for a child's `bash` tool.
 *
 * Two backends are supported, both of which fail closed:
 * - macOS: `sandbox-exec` with a generated seatbelt profile (write inside the
 *   working directory and the temp dir only; network denied).
 * - Linux: `bwrap` (bubblewrap) with a read-only root, a writable cwd and temp
 *   dir, and `--unshare-net`.
 *
 * The profile/argv builders are pure and golden-tested. The wrappers refuse to
 * run when the backend binary is missing rather than silently executing
 * unsandboxed — `sandbox: os` means sandboxed or not at all.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export type SandboxBackend = "seatbelt" | "bwrap";

/** Seatbelt profile name used by `sandbox-exec -f`. */
export const SEATBELT_PROFILE_NAME = "mx-pi-agents";

/** Escape a path for a seatbelt `(literal ...)` / `(subpath ...)` clause. */
function seatbeltQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Generate a seatbelt profile.
 *
 * Default deny, then: read everything (a sandbox that hides the source tree
 * cannot do useful work), write only under `writeRoots`, and no network. The
 * write list is the child's working directory plus its temp directory, which
 * is what keeps `sandbox: os` from becoming a filesystem-wide capability.
 */
export function buildSeatbeltProfile(writeRoots: readonly string[]): string {
	const lines = ["(version 1)", "(deny default)", "(allow process-exec*)", "(allow process-fork)", "(allow signal)"];

	lines.push("; reads are unrestricted: the grant is about writes, not secrecy");
	lines.push("(allow file-read*)");
	lines.push("(allow sysctl-read)");
	lines.push("(allow mach-lookup)");

	lines.push("; writes only under the roots the runner explicitly allows");
	lines.push("(deny file-write*)");
	for (const root of writeRoots) {
		lines.push(`(allow file-write* (subpath ${seatbeltQuote(root)}))`);
	}

	lines.push("; no network egress from a sandboxed child");
	lines.push("(deny network*)");

	return lines.join("\n");
}

/** Build the `sandbox-exec` argv that runs `command` under the profile. */
export function buildSeatbeltArgv(profilePath: string, command: string): string[] {
	return ["-f", profilePath, "/bin/bash", "-c", command];
}

/** Build the `bwrap` argv that runs `command` with the given writable roots. */
export function buildBwrapArgv(command: string, writeRoots: readonly string[], cwd: string): string[] {
	const args = [
		"--unshare-all",
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
	];
	for (const root of writeRoots) args.push("--bind", root, root);
	args.push("--chdir", cwd, "/bin/bash", "-c", command);
	return args;
}

/**
 * Locate an executable on PATH without spawning anything.
 *
 * `pathValue` has no default on purpose: `undefined` means "no PATH to search",
 * so a caller that wants the ambient PATH passes `process.env.PATH` explicitly.
 */
export function whichBinary(name: string, pathValue: string | undefined): string | undefined {
	if (pathValue === undefined) return undefined;
	for (const dir of pathValue.split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Sandbox backend for this platform, or undefined when unsupported. */
export function detectBackend(platform: NodeJS.Platform = process.platform): SandboxBackend | undefined {
	if (platform === "darwin") return "seatbelt";
	if (platform === "linux") return "bwrap";
	return undefined;
}

/** Whether `sandbox: os` can be honoured on this machine. */
export function isSandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
	const backend = detectBackend(platform);
	if (backend === undefined) return false;
	if (backend === "seatbelt") return existsSync("/usr/bin/sandbox-exec");
	return whichBinary("bwrap", process.env.PATH) !== undefined;
}

/** Reason `sandbox: os` is unavailable, for a refusal message. */
export function sandboxUnavailableReason(platform: NodeJS.Platform = process.platform): string {
	const backend = detectBackend(platform);
	if (backend === undefined) return `sandbox: os is not supported on ${platform}`;
	if (backend === "seatbelt") return "sandbox-exec is not available at /usr/bin/sandbox-exec";
	return "bwrap (bubblewrap) is not installed";
}

export interface SandboxBashOptions {
	/** Roots the command may write to. */
	writeRoots: readonly string[];
	/** Platform override for tests. */
	platform?: NodeJS.Platform;
}

/**
 * Wrap pi's local bash operations so every command runs inside the sandbox.
 *
 * The wrapper delegates process handling to pi's own `BashOperations`, so
 * timeout/abort/streaming behaviour is identical to an unsandboxed bash — only
 * the argv changes. That is what makes this a sandbox, not a reimplementation.
 */
export function createSandboxedBashOperations(local: BashOperations, options: SandboxBashOptions): BashOperations {
	const platform = options.platform ?? process.platform;
	const backend = detectBackend(platform);
	if (backend === undefined) {
		throw new Error(sandboxUnavailableReason(platform));
	}

	return {
		exec(command, cwd, execOptions) {
			const roots = options.writeRoots.length > 0 ? options.writeRoots : [cwd];
			if (backend === "seatbelt") {
				// The profile is passed inline via `-p` so no temp file is created
				// inside the target repository.
				const profile = buildSeatbeltProfile(roots);
				return local.exec(
					`sandbox-exec -p ${shellQuote(profile)} /bin/bash -c ${shellQuote(command)}`,
					cwd,
					execOptions,
				);
			}
			const bwrap = whichBinary("bwrap", process.env.PATH);
			if (bwrap === undefined) throw new Error(sandboxUnavailableReason(platform));
			const argv = buildBwrapArgv(command, roots, cwd);
			return local.exec([bwrap, ...argv].map(shellQuote).join(" "), cwd, execOptions);
		},
	};
}

/** POSIX single-quote a string for embedding in a shell command. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

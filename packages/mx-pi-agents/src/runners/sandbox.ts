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

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export type SandboxBackend = "seatbelt" | "bwrap";

/** Seatbelt profile name used by `sandbox-exec -f`. */
export const SEATBELT_PROFILE_NAME = "mx-pi-agents";

/**
 * Immutable runtime surface a sandboxed shell needs to start at all. The
 * `system.sb` import grants the system runtime (the dynamic loader, `/dev`,
 * `/etc`) but not user data; the three binary directories are added explicitly
 * because `system.sb` alone does not let the shell find `cat`/`ls`. Reading
 * `$HOME`, `~/.pi`, `~/.ssh`, `~/Library`, another project or a temp directory
 * outside the run scope stays denied. Hand-listing every runtime path does not
 * work — bash aborts on a missing dyld/IPC allowance — so the import is the
 * honest, working form of the allowlist.
 */
export const SEATBELT_SYSTEM_PROFILE = "system.sb";

/**
 * System binary directories a sandboxed shell must read to exec external tools:
 * the immutable system surface plus the resolved JavaScript toolchain.
 */
export const SEATBELT_SYSTEM_READ_ROOTS: readonly string[] = uniqueRoots([
	"/usr",
	"/bin",
	"/sbin",
	...toolchainReadRoots(),
	...packageManagerReadRoots(),
	...sandboxTempRoots(),
]);

/**
 * The package-manager prefix a binary was installed under.
 *
 * A Homebrew binary lives at `<prefix>/Cellar/<formula>/<version>/bin/<name>`, so
 * the prefix is the ancestor above `Cellar`. Any other layout (nvm, fnm, volta, a
 * manual install) uses the install prefix two levels above the binary.
 */
function toolchainPrefix(execPath: string): string {
	let real = execPath;
	try {
		real = realpathSync(execPath);
	} catch {
		/* fall back to the unresolved path */
	}
	const marker = "/Cellar/";
	const index = real.indexOf(marker);
	if (index > 0) return real.slice(0, index);
	return dirname(dirname(real));
}

/**
 * Library directories of the prefix that installed the toolchain.
 *
 * `node` does not carry its dynamic dependencies: on Homebrew the runtime links
 * against sibling formulae, reached as `<prefix>/opt/<formula>` and stored under
 * `<prefix>/Cellar/<formula>`. Without both, dyld aborts with `Library not
 * loaded ... (blocked by sandbox)` before any test can start. The prefix's `etc` is
 * also allowed, because the runtime reads its own configuration there (for example
 * `openssl.cnf`) and aborts at OpenSSL initialisation if it cannot — so `node
 * --version` works but every script fails without it. Only directories that exist
 * are returned, and the home directory is refused as a library prefix so a stray
 * install directly in `$HOME` cannot grant the whole home tree.
 */
export function toolchainLibraryRoots(execPath: string): string[] {
	const prefix = toolchainPrefix(execPath);
	if (prefix === homedir() || prefix === "/") return [];
	const roots: string[] = [];
	for (const name of ["bin", "lib", "opt", "Cellar", "etc"]) {
		const candidate = join(prefix, name);
		if (existsSync(candidate)) roots.push(candidate);
	}
	return roots;
}

/**
 * Real directories that hold the JavaScript toolchain.
 *
 * A sandboxed `bash` must be able to exec `node`, `npm` and `npx`, and on most
 * installs those live outside `/usr`, `/bin` and `/sbin` (Homebrew, nvm, fnm,
 * volta). The paths are derived from the running process — the toolchain the
 * operator actually has — and resolved through realpath, because seatbelt
 * matches real paths. Anything unresolvable contributes nothing rather than a
 * guess, so this function is total.
 */
export function toolchainReadRoots(
	execPath: string = process.execPath,
	path: string | undefined = process.env.PATH,
): string[] {
	const roots: string[] = [];

	const add = (candidate: string | undefined): void => {
		if (candidate === undefined || candidate.length === 0) return;
		try {
			const real = realpathSync(candidate);
			// The unresolved path matters too: reading `npm` follows a symlink, so
			// both the symlink's directory and its target's directory must be readable.
			roots.push(dirname(candidate));
			roots.push(dirname(real));
			// A package manager may keep its global modules beside the prefix
			// rather than under it, so include the enclosing `node_modules`.
			const parts = real.split("/");
			const index = parts.lastIndexOf("node_modules");
			if (index > 0) roots.push(parts.slice(0, index + 1).join("/"));
		} catch {
			/* an unresolvable candidate contributes nothing */
		}
	};

	add(execPath);
	for (const name of ["npm", "npx"]) add(whichBinary(name, path));

	// The node install prefix holds the runtime's own libraries.
	try {
		roots.push(dirname(dirname(realpathSync(execPath))));
	} catch {
		/* nothing to add */
	}

	roots.push(...toolchainLibraryRoots(execPath));

	return uniqueRoots(roots).filter((root) => root.length > 1 && root !== "/");
}

/** System paths a `bwrap` child needs read-only to exec bash (Linux). */
export const BWRAP_READ_ROOTS: readonly string[] = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

/** Deduplicate roots while preserving order. */
function uniqueRoots(roots: readonly string[]): string[] {
	const out: string[] = [];
	for (const root of roots) if (root.length > 0 && !out.includes(root)) out.push(root);
	return out;
}

/** Escape a path for a seatbelt `(literal ...)` / `(subpath ...)` clause. */
function seatbeltQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Scratch directories a sandboxed child may read and write.
 *
 * A test runner routinely needs scratch space outside the project. The system
 * temp directory is the only such place granted, and it is resolved through
 * realpath because seatbelt matches real paths (`/tmp` is a symlink to
 * `/private/tmp` on macOS). `TMPDIR` is honoured so the caller's own temp root is
 * covered rather than guessed.
 */
export function sandboxTempRoots(tmp: string | undefined = process.env.TMPDIR): string[] {
	const roots: string[] = [];
	for (const candidate of [tmp ?? "", "/tmp", "/private/tmp"]) {
		if (candidate.length === 0) continue;
		try {
			roots.push(realpathSync(candidate));
		} catch {
			/* an absent temp directory contributes nothing */
		}
	}
	return uniqueRoots(roots);
}

/**
 * Roots the package manager reads for its own cache and user configuration.
 *
 * npm reads its cache and `~/.npmrc`; denying them is usually tolerated but turns
 * into confusing warnings, so the cache is granted read-only. It is deliberately
 * never a write root: a sandboxed child must not be able to poison a cache that
 * the unsandboxed host later reads.
 */
export function packageManagerReadRoots(
	cache: string = process.env.npm_config_cache ?? join(homedir(), ".npm"),
): string[] {
	if (cache.length === 0) return [];
	try {
		return [realpathSync(cache)];
	} catch {
		return [];
	}
}

/**
 * Generate a seatbelt profile.
 *
 * Default deny, then: read the immutable system allowlist plus the run's read
 * roots (never a bare host-wide `(allow file-read*)`), write only under
 * `writeRoots` plus the system temp directory, and no network. A global metadata
 * read (`file-read-metadata`) is granted so path resolution can stat every
 * ancestor of an entry path — metadata only, never contents. Writes are the
 * primary capability this sandbox bounds; read confinement is per-root plus the
 * documented system allowance.
 */
export function buildSeatbeltProfile(writeRoots: readonly string[], readRoots: readonly string[] = []): string {
	const lines = ["(version 1)", "(deny default)"];

	lines.push(`; system runtime surface; grants process startup, not user data`);
	lines.push(`(import ${seatbeltQuote(SEATBELT_SYSTEM_PROFILE)})`);
	lines.push("(allow process-exec*)");
	lines.push("(allow process-fork)");
	lines.push("(allow signal)");

	lines.push("; reads: the system binary directories plus the run scope (no host-wide file-read*)");
	for (const root of uniqueRoots([...SEATBELT_SYSTEM_READ_ROOTS, ...readRoots])) {
		lines.push(`(allow file-read* (subpath ${seatbeltQuote(root)}))`);
	}
	lines.push("; path resolution needs to stat every ancestor, not just the roots");
	lines.push("(allow file-read-metadata)");
	lines.push("(allow sysctl-read)");
	lines.push("(allow mach-lookup)");

	lines.push("; writes only under the run scope plus the system temp directory");
	lines.push("(deny file-write*)");
	for (const root of uniqueRoots([...writeRoots, ...sandboxTempRoots()])) {
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
export function buildBwrapArgv(
	command: string,
	writeRoots: readonly string[],
	readRoots: readonly string[] = [],
	cwd: string,
): string[] {
	const args = ["--unshare-all", "--die-with-parent"];
	// Read-only binds for the system runtime and the run scope. There is no
	// `--ro-bind / /`: the child sees only these roots.
	for (const root of uniqueRoots([...BWRAP_READ_ROOTS, ...readRoots])) args.push("--ro-bind", root, root);
	args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
	for (const root of uniqueRoots(writeRoots)) args.push("--bind", root, root);
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
	/** Roots the command may read, in addition to the system allowlist. Defaults to `writeRoots`. */
	readRoots?: readonly string[];
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
			const writeRoots = options.writeRoots.length > 0 ? options.writeRoots : [cwd];
			const readRoots = options.readRoots !== undefined ? options.readRoots : writeRoots;
			if (backend === "seatbelt") {
				// The profile is passed inline via `-p` so no temp file is created
				// inside the target repository.
				const profile = buildSeatbeltProfile(writeRoots, readRoots);
				return local.exec(
					`sandbox-exec -p ${shellQuote(profile)} /bin/bash -c ${shellQuote(command)}`,
					cwd,
					execOptions,
				);
			}
			const bwrap = whichBinary("bwrap", process.env.PATH);
			if (bwrap === undefined) throw new Error(sandboxUnavailableReason(platform));
			const argv = buildBwrapArgv(command, writeRoots, readRoots, cwd);
			return local.exec([bwrap, ...argv].map(shellQuote).join(" "), cwd, execOptions);
		},
	};
}

/** POSIX single-quote a string for embedding in a shell command. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

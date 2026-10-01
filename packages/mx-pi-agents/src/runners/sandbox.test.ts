import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BWRAP_READ_ROOTS,
	buildBwrapArgv,
	buildSeatbeltArgv,
	buildSeatbeltProfile,
	createSandboxedBashOperations,
	detectBackend,
	isSandboxAvailable,
	SEATBELT_PROFILE_NAME,
	SEATBELT_SYSTEM_READ_ROOTS,
	sandboxUnavailableReason,
	shellQuote,
	whichBinary,
} from "./sandbox.js";
import { writeSystemPromptFile } from "./subprocess.js";

describe("buildSeatbeltProfile", () => {
	it("denies by default and allows writes only under the roots", () => {
		const profile = buildSeatbeltProfile(["/work/repo"], ["/work/repo"]);
		expect(profile).toContain("(deny default)");
		expect(profile).toContain("(deny file-write*)");
		expect(profile).toContain('(allow file-write* (subpath "/work/repo"))');
		expect(profile).not.toContain("(allow file-write*)");
	});

	it("denies network", () => {
		expect(buildSeatbeltProfile(["/work"], ["/work"]).includes("(deny network*)")).toBe(true);
	});

	it("imports the system runtime profile and never allows a bare host-wide read", () => {
		const profile = buildSeatbeltProfile(["/work"], ["/work"]);
		expect(profile).toContain('(import "system.sb")');
		expect(profile).not.toMatch(/\(allow file-read\*\)/);
	});

	it("emits one read clause per system allowlist root and per scope root", () => {
		const profile = buildSeatbeltProfile(["/work"], ["/work", "/other"]);
		for (const root of SEATBELT_SYSTEM_READ_ROOTS) {
			expect(profile).toContain(`(allow file-read* (subpath "${root}"))`);
		}
		expect(profile).toContain('(allow file-read* (subpath "/work"))');
		expect(profile).toContain('(allow file-read* (subpath "/other"))');
	});

	it("emits one write clause per root", () => {
		const profile = buildSeatbeltProfile(["/a", "/b"], ["/a", "/b"]);
		expect(profile).toContain('(allow file-write* (subpath "/a"))');
		expect(profile).toContain('(allow file-write* (subpath "/b"))');
	});

	it("escapes quotes in paths", () => {
		const profile = buildSeatbeltProfile(['/we"ird'], ['/we"ird']);
		expect(profile).toContain('(subpath "/we\\"ird")');
	});

	it("produces a stable golden profile", () => {
		const expected = [
			"(version 1)",
			"(deny default)",
			"; system runtime surface; grants process startup, not user data",
			'(import "system.sb")',
			"(allow process-exec*)",
			"(allow process-fork)",
			"(allow signal)",
			"; reads: the system binary directories plus the run scope (no host-wide file-read*)",
			...SEATBELT_SYSTEM_READ_ROOTS.map((root) => `(allow file-read* (subpath "${root}"))`),
			'(allow file-read* (subpath "/r"))',
			"(allow sysctl-read)",
			"(allow mach-lookup)",
			"; writes only under the roots the runner explicitly allows",
			"(deny file-write*)",
			'(allow file-write* (subpath "/w"))',
			"; no network egress from a sandboxed child",
			"(deny network*)",
		].join("\n");
		expect(buildSeatbeltProfile(["/w"], ["/r"])).toBe(expected);
	});
});

describe("buildSeatbeltArgv", () => {
	it("passes the profile file and runs bash", () => {
		expect(buildSeatbeltArgv("/tmp/p.sb", "ls")).toEqual(["-f", "/tmp/p.sb", "/bin/bash", "-c", "ls"]);
	});
});

describe("buildBwrapArgv", () => {
	it("unshares all namespaces and binds the writable roots", () => {
		const argv = buildBwrapArgv("ls", ["/work"], ["/work"], "/work");
		expect(argv).toContain("--unshare-all");
		expect(argv).toContain("--die-with-parent");
		expect(argv).toContain("--ro-bind");
		expect(argv).toContain("--tmpfs");
		const bindIndex = argv.indexOf("--bind");
		expect(argv.slice(bindIndex, bindIndex + 3)).toEqual(["--bind", "/work", "/work"]);
	});

	it("never binds the filesystem root read-only", () => {
		const argv = buildBwrapArgv("ls", ["/work"], ["/work"], "/work");
		expect(argv.join(" ")).not.toContain("--ro-bind / /");
	});

	it("ro-binds the system allowlist and the scope read roots", () => {
		const argv = buildBwrapArgv("ls", ["/work"], ["/work"], "/work");
		for (const root of BWRAP_READ_ROOTS) {
			expect(argv.join(" ")).toContain(`--ro-bind ${root} ${root}`);
		}
		expect(argv.join(" ")).toContain("--ro-bind /work /work");
	});

	it("chdirs into the working directory and runs bash", () => {
		const argv = buildBwrapArgv("ls", ["/work"], ["/work"], "/work");
		const chdirIndex = argv.indexOf("--chdir");
		expect(argv.slice(chdirIndex)).toEqual(["--chdir", "/work", "/bin/bash", "-c", "ls"]);
	});

	it("golden-matches a full argv", () => {
		expect(buildBwrapArgv("ls", ["/w"], ["/r"], "/w")).toEqual([
			"--unshare-all",
			"--die-with-parent",
			...BWRAP_READ_ROOTS.flatMap((root) => ["--ro-bind", root, root]),
			"--ro-bind",
			"/r",
			"/r",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--tmpfs",
			"/tmp",
			"--bind",
			"/w",
			"/w",
			"--chdir",
			"/w",
			"/bin/bash",
			"-c",
			"ls",
		]);
	});
});

describe("detectBackend", () => {
	it("maps platforms to backends", () => {
		expect(detectBackend("darwin")).toBe("seatbelt");
		expect(detectBackend("linux")).toBe("bwrap");
		expect(detectBackend("win32")).toBeUndefined();
		expect(detectBackend("freebsd")).toBeUndefined();
	});
});

describe("sandboxUnavailableReason", () => {
	it("names the missing backend", () => {
		expect(sandboxUnavailableReason("win32")).toContain("not supported");
		expect(sandboxUnavailableReason("darwin")).toContain("sandbox-exec");
		expect(sandboxUnavailableReason("linux")).toContain("bwrap");
	});
});

describe("whichBinary", () => {
	it("finds an existing binary on PATH", () => {
		const found = whichBinary("sh", "/bin:/usr/bin");
		expect(found).toBe("/bin/sh");
	});

	it("returns undefined for a missing binary", () => {
		expect(whichBinary("definitely-not-a-real-binary-xyz", "/bin")).toBeUndefined();
	});

	it("returns undefined without a PATH", () => {
		expect(whichBinary("sh", undefined)).toBeUndefined();
	});
});

describe("isSandboxAvailable", () => {
	it("is false on unsupported platforms", () => {
		expect(isSandboxAvailable("win32")).toBe(false);
	});

	it("reflects the real backend on this platform", () => {
		expect(isSandboxAvailable(process.platform)).toBe(isSandboxAvailable());
	});
});

describe("createSandboxedBashOperations", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
		"runs a command under the narrowed seatbelt profile",
		async () => {
			// The profile is only useful if bash can still start under it. This is the
			// smoke test for the read narrowing's system allowlist.
			dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-pi-agents-sandbox-smoke-")));
			writeFileSync(join(dir, "in.txt"), "INSIDE_MARKER");
			const operations = createSandboxedBashOperations(createLocalBashOperations(), {
				writeRoots: [dir],
				readRoots: [dir],
			});
			const chunks: Buffer[] = [];
			const result = await operations.exec(`cat ${join(dir, "in.txt")}`, dir, {
				onData: (data: Buffer) => chunks.push(data),
			});
			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf8")).toContain("INSIDE_MARKER");
		},
	);

	it("refuses to construct on an unsupported platform", () => {
		expect(() =>
			createSandboxedBashOperations({ exec: vi.fn() }, { writeRoots: ["/work"], platform: "win32" }),
		).toThrow(/not supported/);
	});

	it("wraps commands through the platform sandbox", async () => {
		dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sandbox-"));
		const exec = vi.fn<(command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }>>(
			async () => ({
				exitCode: 0,
			}),
		);
		const operations = createSandboxedBashOperations({ exec }, { writeRoots: [dir], platform: "darwin" });

		await operations.exec("echo hi", dir, { onData: () => {} });

		expect(exec).toHaveBeenCalledOnce();
		const command = exec.mock.calls[0]?.[0] ?? "";
		expect(command).toContain("sandbox-exec");
		expect(command).toContain("(deny network*)");
		expect(command).toContain("echo hi");
		// The profile is passed inline, so no file is created in the target repo.
		expect(command).toContain("-p ");
	});

	it("does not create any file inside the working directory", async () => {
		dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sandbox-"));
		const exec = vi.fn<(command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }>>(
			async () => ({ exitCode: 0 }),
		);
		const operations = createSandboxedBashOperations({ exec }, { writeRoots: [dir], platform: "darwin" });
		await operations.exec("true", dir, { onData: () => {} });
		expect(existsSync(join(dir, "system-prompt.md"))).toBe(false);
	});

	it("falls back to the cwd when no write roots are given", async () => {
		dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sandbox-"));
		const exec = vi.fn<(command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }>>(
			async () => ({
				exitCode: 0,
			}),
		);
		const operations = createSandboxedBashOperations({ exec }, { writeRoots: [], platform: "darwin" });
		await operations.exec("true", dir, { onData: () => {} });
		expect(exec.mock.calls[0]?.[0] ?? "").toContain(dir);
	});

	it("uses bwrap on linux when available", async () => {
		dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sandbox-"));
		const exec = vi.fn<(command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }>>(
			async () => ({
				exitCode: 0,
			}),
		);
		const operations = createSandboxedBashOperations({ exec }, { writeRoots: [dir], platform: "linux" });
		if (whichBinary("bwrap", process.env.PATH) === undefined) {
			expect(() => operations.exec("true", dir!, { onData: () => {} })).toThrow(/bwrap/);
			return;
		}
		await operations.exec("true", dir, { onData: () => {} });
		expect(exec.mock.calls[0]?.[0] ?? "").toContain("--unshare-all");
	});
});

describe("shellQuote", () => {
	it("single-quotes plain values", () => {
		expect(shellQuote("abc")).toBe("'abc'");
	});

	it("escapes embedded single quotes", () => {
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
	});

	it("neutralizes shell metacharacters", () => {
		expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
	});
});

describe("temp file permissions", () => {
	it("writes the system prompt as 0600 inside a 0700 dir", () => {
		const written = writeSystemPromptFile("explorer", "prompt");
		try {
			expect(statSync(written.path).mode & 0o777).toBe(0o600);
			expect(statSync(written.dir).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(written.dir, { recursive: true, force: true });
		}
	});
});

describe("sandbox: boundary hardening", () => {
	it("detectBackend maps supported platforms and rejects others", () => {
		expect(detectBackend("darwin")).toBe("seatbelt");
		expect(detectBackend("linux")).toBe("bwrap");
		expect(detectBackend("win32")).toBeUndefined();
	});

	it("sandboxUnavailableReason names the platform or the missing binary", () => {
		expect(sandboxUnavailableReason("win32")).toContain("not supported on win32");
		expect(sandboxUnavailableReason("darwin")).toContain("sandbox-exec");
		expect(sandboxUnavailableReason("linux")).toContain("bwrap");
	});

	it("isSandboxAvailable is false on an unsupported platform", () => {
		expect(isSandboxAvailable("win32")).toBe(false);
	});

	it("whichBinary returns undefined without a PATH", () => {
		expect(whichBinary("node", undefined)).toBeUndefined();
		expect(whichBinary("node", "")).toBeUndefined();
	});

	it("buildSeatbeltArgv wraps the command", () => {
		expect(buildSeatbeltArgv("/p.sb", "echo hi")).toEqual(["-f", "/p.sb", "/bin/bash", "-c", "echo hi"]);
	});

	it("buildSeatbeltProfile dedupes roots and denies by default", () => {
		const profile = buildSeatbeltProfile(["/w", "/w", ""], ["/r", "/r"]);
		expect(profile).toContain("(deny default)");
		expect(profile.match(/file-write\* \(subpath "\/w"\)/g)).toHaveLength(1);
		expect(profile).toContain("(deny network*)");
	});

	it("buildBwrapArgv binds roots and chdirs", () => {
		const args = buildBwrapArgv("echo hi", ["/w"], ["/r"], "/cwd");
		expect(args).toContain("--unshare-all");
		expect(args.filter((arg) => arg === "--ro-bind")).toHaveLength(BWRAP_READ_ROOTS.length + 1);
		expect(args[args.indexOf("--chdir") + 1]).toBe("/cwd");
		expect(args[args.length - 1]).toBe("echo hi");
	});

	it("createSandboxedBashOperations throws on an unsupported platform", () => {
		expect(() =>
			createSandboxedBashOperations({ exec: vi.fn() } as never, { writeRoots: ["/w"], platform: "win32" }),
		).toThrow(/not supported/);
	});

	it("createSandboxedBashOperations runs seatbelt with an inline profile", () => {
		const exec = vi.fn(() => Promise.resolve({ exitCode: 0 }));
		const operations = createSandboxedBashOperations({ exec } as never, { writeRoots: ["/w"], platform: "darwin" });
		void operations.exec("echo hi", "/cwd", { onData: () => {} });
		expect(exec).toHaveBeenCalledTimes(1);
		const [command] = exec.mock.calls[0] as unknown as [string];
		expect(command).toContain("sandbox-exec -p");
		expect(command).toContain("/bin/bash -c");
	});
});

describe("sandbox: survivor kills", () => {
	it("pins the profile name and bwrap read roots", () => {
		expect(SEATBELT_PROFILE_NAME).toBe("mx-pi-agents");
		expect(BWRAP_READ_ROOTS).toEqual(["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]);
	});

	it("drops empty roots from the profile", () => {
		const profile = buildSeatbeltProfile(["/w", ""], ["/r", ""]);
		expect(profile).not.toContain('(subpath "")');
	});

	it("reflects sandbox-exec and bwrap availability", () => {
		expect(isSandboxAvailable("darwin")).toBe(existsSync("/usr/bin/sandbox-exec"));
		expect(isSandboxAvailable("linux")).toBe(whichBinary("bwrap", process.env.PATH) !== undefined);
		expect(sandboxUnavailableReason("linux")).toBe("bwrap (bubblewrap) is not installed");
		expect(sandboxUnavailableReason("darwin")).toBe("sandbox-exec is not available at /usr/bin/sandbox-exec");
	});

	it("uses the explicit writeRoots rather than the cwd", async () => {
		const exec = vi.fn<(command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }>>(
			async () => ({ exitCode: 0 }),
		);
		const operations = createSandboxedBashOperations({ exec }, { writeRoots: ["/w"], platform: "darwin" });
		await operations.exec("true", "/cwd", { onData: () => {} });
		expect(exec.mock.calls[0]?.[0] ?? "").toContain('(subpath "/w")');
	});

	it("uses writeRoots as the read roots when none are given", async () => {
		const exec = vi.fn<(command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }>>(
			async () => ({ exitCode: 0 }),
		);
		const operations = createSandboxedBashOperations({ exec }, { writeRoots: ["/w"], platform: "darwin" });
		await operations.exec("true", "/cwd", { onData: () => {} });
		expect(exec.mock.calls[0]?.[0] ?? "").toContain('(allow file-read* (subpath "/w"))');
	});

	it("uses explicit readRoots when given", async () => {
		const exec = vi.fn<(command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }>>(
			async () => ({ exitCode: 0 }),
		);
		const operations = createSandboxedBashOperations(
			{ exec },
			{ writeRoots: ["/w"], readRoots: ["/r"], platform: "darwin" },
		);
		await operations.exec("true", "/cwd", { onData: () => {} });
		expect(exec.mock.calls[0]?.[0] ?? "").toContain('(allow file-read* (subpath "/r"))');
	});

	it("shell-quotes the bwrap command when bwrap is on PATH", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sandbox-kill-"));
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "bwrap"), "");
		const originalPath = process.env.PATH;
		process.env.PATH = `${bin}:/usr/bin:/bin`;
		try {
			const exec = vi.fn<(command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }>>(
				async () => ({ exitCode: 0 }),
			);
			const operations = createSandboxedBashOperations({ exec }, { writeRoots: [dir], platform: "linux" });
			await operations.exec("echo hi", dir, { onData: () => {} });
			const command = exec.mock.calls[0]?.[0] ?? "";
			expect(command).toContain("--unshare-all");
			expect(command).toContain("'/bin/bash'");
			expect(command).toContain("'echo hi'");
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

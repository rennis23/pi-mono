import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildBwrapArgv,
	buildSeatbeltArgv,
	buildSeatbeltProfile,
	createSandboxedBashOperations,
	detectBackend,
	isSandboxAvailable,
	sandboxUnavailableReason,
	shellQuote,
	whichBinary,
} from "./sandbox.js";
import { writeSystemPromptFile } from "./subprocess.js";

describe("buildSeatbeltProfile", () => {
	it("denies by default and allows writes only under the roots", () => {
		const profile = buildSeatbeltProfile(["/work/repo"]);
		expect(profile).toContain("(deny default)");
		expect(profile).toContain("(deny file-write*)");
		expect(profile).toContain('(allow file-write* (subpath "/work/repo"))');
		expect(profile).not.toContain("(allow file-write*)");
	});

	it("denies network", () => {
		expect(buildSeatbeltProfile(["/work"]).includes("(deny network*)")).toBe(true);
	});

	it("allows reads so the child can see the source tree", () => {
		expect(buildSeatbeltProfile(["/work"]).includes("(allow file-read*)")).toBe(true);
	});

	it("emits one clause per root", () => {
		const profile = buildSeatbeltProfile(["/a", "/b"]);
		expect(profile).toContain('(allow file-write* (subpath "/a"))');
		expect(profile).toContain('(allow file-write* (subpath "/b"))');
	});

	it("escapes quotes in paths", () => {
		const profile = buildSeatbeltProfile(['/we"ird']);
		expect(profile).toContain('(subpath "/we\\"ird")');
	});

	it("produces a stable golden profile", () => {
		expect(buildSeatbeltProfile(["/w"])).toMatchInlineSnapshot(`
			"(version 1)
			(deny default)
			(allow process-exec*)
			(allow process-fork)
			(allow signal)
			; reads are unrestricted: the grant is about writes, not secrecy
			(allow file-read*)
			(allow sysctl-read)
			(allow mach-lookup)
			; writes only under the roots the runner explicitly allows
			(deny file-write*)
			(allow file-write* (subpath "/w"))
			; no network egress from a sandboxed child
			(deny network*)"
		`);
	});
});

describe("buildSeatbeltArgv", () => {
	it("passes the profile file and runs bash", () => {
		expect(buildSeatbeltArgv("/tmp/p.sb", "ls")).toEqual(["-f", "/tmp/p.sb", "/bin/bash", "-c", "ls"]);
	});
});

describe("buildBwrapArgv", () => {
	it("unshares all namespaces and binds the writable roots", () => {
		const argv = buildBwrapArgv("ls", ["/work"], "/work");
		expect(argv).toContain("--unshare-all");
		expect(argv).toContain("--die-with-parent");
		expect(argv).toContain("--ro-bind");
		expect(argv).toContain("--tmpfs");
		const bindIndex = argv.indexOf("--bind");
		expect(argv.slice(bindIndex, bindIndex + 3)).toEqual(["--bind", "/work", "/work"]);
	});

	it("chdirs into the working directory and runs bash", () => {
		const argv = buildBwrapArgv("ls", ["/work"], "/work");
		const chdirIndex = argv.indexOf("--chdir");
		expect(argv.slice(chdirIndex)).toEqual(["--chdir", "/work", "/bin/bash", "-c", "ls"]);
	});

	it("golden-matches a full argv", () => {
		expect(buildBwrapArgv("ls", ["/work"], "/work")).toMatchInlineSnapshot(`
			[
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
			  "--bind",
			  "/work",
			  "/work",
			  "--chdir",
			  "/work",
			  "/bin/bash",
			  "-c",
			  "ls",
			]
		`);
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
		const exec = vi.fn(async () => ({ exitCode: 0 }));
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

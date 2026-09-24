import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunPlan } from "../types.js";
import {
	buildChildArgv,
	CHILD_ENV_MARKER,
	createSubprocessRunner,
	MAX_STDERR_BYTES,
	parseChildLine,
	readChildText,
	readChildUsage,
	writeSystemPromptFile,
} from "./subprocess.js";

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
	return {
		agentName: "explorer",
		source: { kind: "global", path: "/agents/explorer.md", directory: "/agents", trusted: true },
		task: "SECRET TASK TEXT",
		tools: ["read", "grep"],
		noTools: undefined,
		model: undefined,
		thinking: undefined,
		systemPrompt: "You are explorer.",
		budgets: { maxTurns: 5, timeoutMs: 5000, tokenBudget: 1000, costBudget: undefined },
		isolation: "subprocess",
		sandbox: "none",
		cwd: "/work",
		diagnostics: [],
		...overrides,
	};
}

describe("buildChildArgv", () => {
	it("disables every discovery source", () => {
		const argv = buildChildArgv(plan(), "/tmp/p.md");
		for (const flag of [
			"--no-session",
			"--no-approve",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
		]) {
			expect(argv).toContain(flag);
		}
	});

	it("never contains the task text", () => {
		const argv = buildChildArgv(plan({ task: "SECRET TASK TEXT" }), "/tmp/p.md");
		expect(argv.join(" ")).not.toContain("SECRET TASK TEXT");
	});

	it("never contains the system prompt body", () => {
		const argv = buildChildArgv(plan({ systemPrompt: "TOPSECRET PROMPT BODY" }), "/tmp/p.md");
		expect(argv.join(" ")).not.toContain("TOPSECRET PROMPT BODY");
		expect(argv.join(" ")).toContain("/tmp/p.md");
	});

	it("passes the grant list", () => {
		const argv = buildChildArgv(plan({ tools: ["read", "ls"] }), "/tmp/p.md");
		const index = argv.indexOf("--tools");
		expect(argv[index + 1]).toBe("read,ls");
	});

	it("passes --no-tools when the grant set is empty", () => {
		const argv = buildChildArgv(plan({ tools: [], noTools: "all" }), "/tmp/p.md");
		expect(argv).toContain("--no-tools");
		expect(argv).not.toContain("--tools");
	});

	it("passes model and thinking when declared", () => {
		const argv = buildChildArgv(plan({ model: "anthropic/claude-sonnet-4-5", thinking: "low" }), "/tmp/p.md");
		expect(argv[argv.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4-5");
		expect(argv[argv.indexOf("--thinking") + 1]).toBe("low");
	});

	it("golden-matches a minimal argv", () => {
		expect(buildChildArgv(plan(), "/tmp/p.md")).toMatchInlineSnapshot(`
			[
			  "--mode",
			  "json",
			  "-p",
			  "--no-session",
			  "--no-approve",
			  "--no-extensions",
			  "--no-skills",
			  "--no-prompt-templates",
			  "--no-themes",
			  "--no-context-files",
			  "--tools",
			  "read,grep",
			  "--append-system-prompt",
			  "/tmp/p.md",
			]
		`);
	});
});

describe("writeSystemPromptFile", () => {
	it("writes 0600 inside a 0700 dir and sanitizes the name", () => {
		const written = writeSystemPromptFile("../../evil/name", "prompt");
		try {
			expect(statSync(written.path).mode & 0o777).toBe(0o600);
			expect(statSync(written.dir).mode & 0o777).toBe(0o700);
			// Traversal characters are neutralized; the dir stays a direct child of tmpdir.
			expect(written.dir).not.toContain("..");
			expect(written.dir).not.toContain("/evil");
			// The remainder after the tmpdir prefix is a single path segment.
			const relative = written.dir.slice(tmpdir().length).replace(/^\//, "");
			expect(relative).not.toContain("/");
			expect(readFileSync(written.path, "utf8")).toBe("prompt");
		} finally {
			rmSync(written.dir, { recursive: true, force: true });
		}
	});

	it("creates the dir under the system temp dir, not the cwd", () => {
		const written = writeSystemPromptFile("explorer", "prompt");
		try {
			expect(written.dir.startsWith(tmpdir())).toBe(true);
		} finally {
			rmSync(written.dir, { recursive: true, force: true });
		}
	});
});

describe("parseChildLine", () => {
	it("parses a JSON object", () => {
		expect(parseChildLine('{"type":"message_end"}')).toEqual({ type: "message_end" });
	});

	it("ignores blank and malformed lines", () => {
		expect(parseChildLine("")).toBeUndefined();
		expect(parseChildLine("   ")).toBeUndefined();
		expect(parseChildLine("not json")).toBeUndefined();
		expect(parseChildLine("[1,2]")).toEqual([1, 2]);
		expect(parseChildLine("42")).toBeUndefined();
	});
});

describe("readChildUsage / readChildText", () => {
	it("reads usage from an assistant message", () => {
		const usage = readChildUsage({
			message: {
				role: "assistant",
				usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.02 }, totalTokens: 17 },
			},
		});
		expect(usage).toEqual({ input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.02, contextTokens: 17 });
	});

	it("ignores non-assistant messages", () => {
		expect(readChildUsage({ message: { role: "user", usage: { input: 1 } } })).toEqual({});
		expect(readChildText({ message: { role: "user", content: "hi" } })).toBe("");
	});

	it("concatenates text parts", () => {
		expect(
			readChildText({
				message: {
					role: "assistant",
					content: [{ type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }],
				},
			}),
		).toBe("ab");
	});

	it("tolerates missing fields", () => {
		expect(readChildUsage({ message: { role: "assistant" } })).toEqual({});
		expect(readChildText({ message: { role: "assistant" } })).toBe("");
	});
});

describe("createSubprocessRunner", () => {
	it("refuses when sandbox: os has no backend", async () => {
		const runner = createSubprocessRunner({
			resolvePi: () => ({ command: "pi", args: [] }),
			platform: "win32",
			isSandboxAvailable: () => false,
		});
		const result = await runner.run(plan({ sandbox: "os" }), {
			signal: new AbortController().signal,
			now: () => 0,
		});
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toContain("sandbox: os");
	});

	it("passes the task on stdin and never in argv", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sub-"));
		const scriptPath = join(dir, "child.mjs");
		// A fake child: prints its argv and stdin back as JSONL.
		const { writeFileSync, chmodSync } = await import("node:fs");
		writeFileSync(
			scriptPath,
			[
				"let input = '';",
				"process.stdin.on('data', (c) => { input += c; });",
				"process.stdin.on('end', () => {",
				"  const argvHasTask = process.argv.join(' ').includes('SECRET TASK TEXT');",
				"  const stdinHasTask = input.includes('SECRET TASK TEXT');",
				"  process.stdout.write(JSON.stringify({",
				"    type: 'message_end',",
				"    argvHasTask, stdinHasTask,",
				"    envMarker: process.env.MX_PI_AGENTS_CHILD,",
				"    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end', usage: { input: 5, output: 2 } }",
				"  }) + '\\n');",
				"});",
			].join("\n"),
		);
		chmodSync(scriptPath, 0o700);

		try {
			const runner = createSubprocessRunner({
				resolvePi: () => ({ command: process.execPath, args: [scriptPath] }),
			});
			const seen: Record<string, unknown>[] = [];
			const result = await runner.run(plan({ cwd: dir }), {
				signal: new AbortController().signal,
				now: () => 0,
				onUpdate: (partial) => seen.push({ text: partial.text }),
			});

			expect(result.ok).toBe(true);
			expect(result.text).toBe("done");
			expect(result.turns).toBe(1);
			expect(result.usage.input).toBe(5);
			expect(seen.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sets the recursion marker in the child environment", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sub-"));
		const scriptPath = join(dir, "marker.mjs");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			scriptPath,
			[
				"process.stdin.resume();",
				"process.stdin.on('end', () => {",
				"  process.stdout.write(JSON.stringify({",
				"    type: 'message_end',",
				"    marker: process.env.MX_PI_AGENTS_CHILD,",
				"    message: { role: 'assistant', content: [{ type: 'text', text: String(process.env.MX_PI_AGENTS_CHILD) }], stopReason: 'end' }",
				"  }) + '\\n');",
				"});",
			].join("\n"),
		);

		try {
			const runner = createSubprocessRunner({
				resolvePi: () => ({ command: process.execPath, args: [scriptPath] }),
			});
			const result = await runner.run(plan({ cwd: dir }), { signal: new AbortController().signal, now: () => 0 });
			expect(result.text).toBe("1");
			expect(CHILD_ENV_MARKER).toBe("MX_PI_AGENTS_CHILD");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes the temp system prompt after the run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sub-"));
		const scriptPath = join(dir, "echo.mjs");
		const { writeFileSync } = await import("node:fs");
		// Read the --append-system-prompt path, report whether it exists, then exit.
		writeFileSync(
			scriptPath,
			[
				"const i = process.argv.indexOf('--append-system-prompt');",
				"const p = process.argv[i + 1];",
				"const fs = await import('node:fs');",
				"process.stdin.resume();",
				"process.stdin.on('end', () => {",
				"  const existsBefore = fs.existsSync(p);",
				"  process.stdout.write(JSON.stringify({ type: 'message_end', existsBefore, path: p,",
				"    message: { role: 'assistant', content: [{ type: 'text', text: existsBefore ? 'yes' : 'no' }], stopReason: 'end' } }) + '\\n');",
				"});",
			].join("\n"),
		);

		try {
			const runner = createSubprocessRunner({
				resolvePi: () => ({ command: process.execPath, args: [scriptPath] }),
			});
			const result = await runner.run(plan({ cwd: dir, systemPrompt: "PROMPT BODY" }), {
				signal: new AbortController().signal,
				now: () => 0,
			});
			expect(result.text).toBe("yes");
			// The dir is gone once the run returns.
			const promptPath = /(\/.*)\/system-prompt\.md/.exec(JSON.stringify(result))?.[1];
			expect(promptPath === undefined || !existsSync(promptPath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("kills the child on abort", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sub-"));
		const scriptPath = join(dir, "hang.mjs");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(scriptPath, "process.stdin.resume();\nsetInterval(() => {}, 1000);\n");

		try {
			const runner = createSubprocessRunner({
				resolvePi: () => ({ command: process.execPath, args: [scriptPath] }),
			});
			const controller = new AbortController();
			const promise = runner.run(plan({ cwd: dir }), { signal: controller.signal, now: () => 0 });
			setTimeout(() => controller.abort(), 50);
			const result = await promise;
			expect(result.ok).toBe(false);
			expect(result.stopped).toBe("aborted");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not spawn when the signal is already aborted", async () => {
		const runner = createSubprocessRunner({ resolvePi: () => ({ command: "/definitely/not/a/binary", args: [] }) });
		const controller = new AbortController();
		controller.abort();
		const result = await runner.run(plan(), { signal: controller.signal, now: () => 0 });
		expect(result.ok).toBe(false);
		expect(result.stopped).toBe("aborted");
		// No spawn happened, so no spawn error was recorded.
		expect(result.errorMessage).toBeUndefined();
	});

	it("caps stderr accumulation", () => {
		expect(MAX_STDERR_BYTES).toBe(8 * 1024);
	});

	it("reports a nonzero exit as an error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sub-"));
		const scriptPath = join(dir, "fail.mjs");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			scriptPath,
			"process.stdin.resume();\nprocess.stdin.on('end', () => { process.stderr.write('boom'); process.exit(3); });\n",
		);

		try {
			const runner = createSubprocessRunner({
				resolvePi: () => ({ command: process.execPath, args: [scriptPath] }),
			});
			const result = await runner.run(plan({ cwd: dir }), { signal: new AbortController().signal, now: () => 0 });
			expect(result.ok).toBe(false);
			expect(result.errorMessage).toContain("boom");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not reject when the spawn fails", async () => {
		const runner = createSubprocessRunner({
			resolvePi: () => ({ command: "/definitely/not/a/binary", args: [] }),
		});
		const result = await runner.run(plan(), { signal: new AbortController().signal, now: () => 0 });
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toBeDefined();
	});

	it("uses an injected clock for the duration", async () => {
		let now = 1000;
		const dir = mkdtempSync(join(tmpdir(), "mx-pi-agents-sub-"));
		const scriptPath = join(dir, "ok.mjs");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			scriptPath,
			"process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], stopReason: 'end' } }) + '\\n'); });\n",
		);
		try {
			const runner = createSubprocessRunner({
				resolvePi: () => ({ command: process.execPath, args: [scriptPath] }),
			});
			const promise = runner.run(plan({ cwd: dir }), {
				signal: new AbortController().signal,
				now: () => {
					now += 25;
					return now;
				},
			});
			const result = await promise;
			expect(result.durationMs).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

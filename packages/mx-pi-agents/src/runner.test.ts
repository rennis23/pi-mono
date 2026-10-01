import { describe, expect, it } from "vitest";
import { selectRunner, unavailableRunner } from "./runner.js";
import type { Runner, RunOptions, RunPlan, RunResult } from "./types.js";

const options: RunOptions = { signal: new AbortController().signal, now: () => 0 };

function planWith(isolation: RunPlan["isolation"]): RunPlan {
	return { isolation, agentName: "explorer", diagnostics: [] } as unknown as RunPlan;
}

function stubRunner(kind: RunPlan["isolation"]): Runner {
	return {
		kind: kind === "subprocess" ? "subprocess" : "process",
		async run(): Promise<RunResult> {
			throw new Error("not used");
		},
	};
}

describe("selectRunner", () => {
	it("selects subprocess only for subprocess isolation", () => {
		const processRunner = stubRunner("process");
		const subprocessRunner = stubRunner("subprocess");
		const registry = { process: processRunner, subprocess: subprocessRunner };
		expect(selectRunner(registry, planWith("subprocess"))).toBe(subprocessRunner);
		expect(selectRunner(registry, planWith("process"))).toBe(processRunner);
	});
});

describe("unavailableRunner", () => {
	it("returns a failed child-error result carrying the message", async () => {
		const runner = unavailableRunner("subprocess", "no backend");
		const result = await runner.run(planWith("subprocess"), options);
		expect(runner.kind).toBe("subprocess");
		expect(result.agent).toBe("explorer");
		expect(result.ok).toBe(false);
		expect(result.partial).toBe(false);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("");
		expect(result.stopped).toBe("child-error");
		expect(result.errorMessage).toBe("no backend");
	});
});

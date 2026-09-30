import { describe, expect, it } from "vitest";
import {
	createProgress,
	markRemaining,
	markRunning,
	markSettled,
	type ProgressModel,
	type ProgressTheme,
	progressCounts,
	renderProgress,
	SPINNER_FRAMES,
} from "./progress.js";

const theme: ProgressTheme = { fg: (_color, text) => text };

function modelOf(...stages: string[][]): ProgressModel {
	return createProgress(stages.map((agents) => ({ agents })));
}

describe("createProgress", () => {
	it("builds stages and waiting units", () => {
		const model = modelOf(["planner"], ["builder"], ["reviewer", "explorer"]);
		expect(model.stages.map((stage) => stage.units.map((unit) => unit.agent))).toEqual([
			["planner"],
			["builder"],
			["reviewer", "explorer"],
		]);
		expect(model.stages.flatMap((stage) => stage.units).every((unit) => unit.status === "waiting")).toBe(true);
	});
});

describe("status transitions", () => {
	it("moves the matching unit to running and then done", () => {
		const model = modelOf(["planner", "builder"]);
		markRunning(model, 0, "builder");
		expect(model.stages[0].units.map((unit) => unit.status)).toEqual(["waiting", "running"]);
		markSettled(model, 0, "builder", true);
		expect(model.stages[0].units.map((unit) => unit.status)).toEqual(["waiting", "done"]);
	});

	it("marks a failed settle", () => {
		const model = modelOf(["planner"]);
		markRunning(model, 0, "planner");
		markSettled(model, 0, "planner", false);
		expect(model.stages[0].units[0].status).toBe("failed");
	});

	it("targets the correct stage when an agent repeats", () => {
		const model = modelOf(["explorer"], ["explorer"]);
		markRunning(model, 1, "explorer");
		expect(model.stages[0].units[0].status).toBe("waiting");
		expect(model.stages[1].units[0].status).toBe("running");
	});

	it("ignores an unknown stage or agent", () => {
		const model = modelOf(["planner"]);
		expect(() => markRunning(model, 9, "planner")).not.toThrow();
		expect(() => markSettled(model, 0, "ghost", true)).not.toThrow();
	});

	it("marks waiting and running units remaining", () => {
		const model = modelOf(["a"], ["b"]);
		markRunning(model, 0, "a");
		markSettled(model, 0, "a", true);
		markRemaining(model, "cancelled");
		expect(model.stages[0].units[0].status).toBe("done");
		expect(model.stages[1].units[0].status).toBe("cancelled");
	});
});

describe("progressCounts", () => {
	it("counts completed against total", () => {
		const model = modelOf(["a"], ["b", "c"]);
		markRunning(model, 0, "a");
		markSettled(model, 0, "a", true);
		expect(progressCounts(model)).toEqual({ done: 1, total: 3 });
	});
});

describe("renderProgress", () => {
	it("renders the header, branches and glyphs", () => {
		const model = modelOf(["planner"], ["builder"], ["reviewer", "explorer"]);
		markRunning(model, 0, "planner");
		markSettled(model, 0, "planner", true);
		markRunning(model, 1, "builder");

		const lines = renderProgress(model, theme, 0);
		expect(lines[0]).toContain("● Agents (1/4)");
		expect(lines[0]).toContain(SPINNER_FRAMES[0]);
		expect(lines[1]).toContain("├─");
		expect(lines[1]).toContain("✓");
		expect(lines[1]).toContain("done");
		expect(lines[2]).toContain("◐");
		expect(lines[2]).toContain("running");
		expect(lines[3]).toContain("└─");
		expect(lines[3]).toContain("○");
		expect(lines[3]).toContain("reviewer, explorer");
		expect(lines[3]).toContain("waiting");
	});

	it("marks a failed stage and drops the spinner when nothing is active", () => {
		const model = modelOf(["planner"], ["builder"]);
		markRunning(model, 0, "planner");
		markSettled(model, 0, "planner", false);
		markRunning(model, 1, "builder");
		markSettled(model, 1, "builder", true);

		const lines = renderProgress(model, theme, 0);
		expect(lines[0]).toContain("● Agents (1/2)");
		expect(lines[1]).toContain("✗");
		expect(lines[2]).toContain("✓");
		expect(lines[0]).not.toContain(SPINNER_FRAMES[0]);
	});

	it("shows a partial count for a mixed stage", () => {
		const model = modelOf(["a", "b"]);
		markRunning(model, 0, "a");
		markSettled(model, 0, "a", true);
		expect(renderProgress(model, theme, 0).join("\n")).toContain("1/2 done");
	});

	it("marks a cancelled stage", () => {
		const model = modelOf(["a", "b"]);
		markRunning(model, 0, "a");
		markRemaining(model, "cancelled");
		expect(renderProgress(model, theme, 0).join("\n")).toContain("⊘");
	});

	it("advances the spinner with the frame", () => {
		const model = modelOf(["a"]);
		const first = renderProgress(model, theme, 0)[0];
		const second = renderProgress(model, theme, 1)[0];
		expect(first).not.toBe(second);
	});

	it("sanitizes a hostile agent name", () => {
		const model = modelOf(["evil\u0007agent"]);
		for (const line of renderProgress(model, theme, 0)) {
			expect(line).not.toMatch(/[\u0000-\u0009\u000B-\u001F]/);
		}
	});
});

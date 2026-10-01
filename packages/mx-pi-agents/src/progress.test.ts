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

describe("progress: survivor kills", () => {
	it("pins the spinner frame sequence", () => {
		expect(SPINNER_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
	});

	it("stays active while any unit is still waiting or running", () => {
		const model: ProgressModel = {
			stages: [
				{
					units: [
						{ id: 0, agent: "a", status: "waiting" },
						{ id: 1, agent: "b", status: "done" },
					],
				},
			],
		};
		expect(renderProgress(model, theme, 0)[0]).toContain(`  ${SPINNER_FRAMES[0]}`);
	});

	it("a failed+done stage is failed", () => {
		const model: ProgressModel = {
			stages: [
				{
					units: [
						{ id: 0, agent: "a", status: "failed" },
						{ id: 1, agent: "b", status: "done" },
					],
				},
			],
		};
		const joined = renderProgress(model, theme, 0).join("\n");
		expect(joined).toContain("✗");
		expect(joined).toContain("failed");
	});

	it("a cancelled+waiting stage is waiting, not cancelled", () => {
		const model: ProgressModel = {
			stages: [
				{
					units: [
						{ id: 0, agent: "a", status: "cancelled" },
						{ id: 1, agent: "b", status: "waiting" },
					],
				},
			],
		};
		const joined = renderProgress(model, theme, 0).join("\n");
		expect(joined).toContain("waiting");
		expect(joined).not.toContain("⊘");
	});
});
describe("progress: boundary hardening", () => {
	it("createProgress assigns increasing ids across stages", () => {
		const model = createProgress([{ agents: ["a", "b"] }, { agents: ["c"] }]);
		expect(model.stages[0].units.map((u) => u.id)).toEqual([0, 1]);
		expect(model.stages[1].units.map((u) => u.id)).toEqual([2]);
		expect(model.stages[0].units.every((u) => u.status === "waiting")).toBe(true);
	});

	it("markRunning targets the first waiting unit, then falls back to any", () => {
		const model = createProgress([{ agents: ["a", "a"] }]);
		markRunning(model, 0, "a");
		expect(model.stages[0].units.map((u) => u.status)).toEqual(["running", "waiting"]);
		markRunning(model, 0, "a");
		expect(model.stages[0].units.map((u) => u.status)).toEqual(["running", "running"]);
	});

	it("markRunning prefers a waiting unit over an already-running one", () => {
		const model: ProgressModel = {
			stages: [
				{
					units: [
						{ id: 0, agent: "a", status: "running" },
						{ id: 1, agent: "a", status: "waiting" },
					],
				},
			],
		};
		markRunning(model, 0, "a");
		expect(model.stages[0].units.map((u) => u.status)).toEqual(["running", "running"]);
	});

	it("markRunning is a no-op for an unknown stage or agent", () => {
		const model = createProgress([{ agents: ["a"] }]);
		markRunning(model, 5, "a");
		markRunning(model, 0, "ghost");
		expect(model.stages[0].units[0].status).toBe("waiting");
	});

	it("markSettled settles running first, then waiting, and maps ok", () => {
		const model = createProgress([{ agents: ["a", "a"] }]);
		markRunning(model, 0, "a");
		markSettled(model, 0, "a", true);
		expect(model.stages[0].units.map((u) => u.status)).toEqual(["done", "waiting"]);
		markSettled(model, 0, "a", false);
		expect(model.stages[0].units.map((u) => u.status)).toEqual(["done", "failed"]);
		markSettled(model, 0, "ghost", true);
		expect(model.stages[0].units.map((u) => u.status)).toEqual(["done", "failed"]);
	});

	it("markRemaining settles every waiting and running unit", () => {
		const model = createProgress([{ agents: ["a"] }, { agents: ["b", "c"] }]);
		markRunning(model, 0, "a");
		markSettled(model, 0, "a", true);
		markRunning(model, 1, "b");
		markRemaining(model, "cancelled");
		expect(model.stages.map((s) => s.units.map((u) => u.status))).toEqual([["done"], ["cancelled", "cancelled"]]);
	});

	it("progressCounts counts done over total", () => {
		const model = createProgress([{ agents: ["a", "b"] }, { agents: ["c"] }]);
		markRunning(model, 0, "a");
		markSettled(model, 0, "a", true);
		markRunning(model, 0, "b");
		markSettled(model, 0, "b", false);
		expect(progressCounts(model)).toEqual({ done: 1, total: 3 });
	});

	it("renderProgress spins only while active and wraps the frame", () => {
		const model = createProgress([{ agents: ["a"] }]);
		expect(renderProgress(model, theme, SPINNER_FRAMES.length)).toEqual(renderProgress(model, theme, 0));
		markRunning(model, 0, "a");
		markSettled(model, 0, "a", true);
		const finished = renderProgress(model, theme, 0);
		expect(finished[0]).toContain("● Agents (1/1)");
		expect(finished[0]).not.toContain("  ");
	});

	it("renderProgress renders every status glyph and label", () => {
		const model: ProgressModel = {
			stages: [
				{ units: [{ id: 0, agent: "w", status: "waiting" }] },
				{ units: [{ id: 1, agent: "r", status: "running" }] },
				{ units: [{ id: 2, agent: "d", status: "done" }] },
				{ units: [{ id: 3, agent: "f", status: "failed" }] },
				{ units: [{ id: 4, agent: "c", status: "cancelled" }] },
			],
		};
		const joined = renderProgress(model, theme, 0).join("\n");
		for (const glyph of ["○", "◐", "✓", "✗", "⊘"]) expect(joined).toContain(glyph);
		for (const label of ["waiting", "running", "done", "failed", "cancelled"]) expect(joined).toContain(label);
	});

	it("stageStatus precedence and the partial-done label", () => {
		const mixed: ProgressModel = {
			stages: [
				{
					units: [
						{ id: 0, agent: "a", status: "done" },
						{ id: 1, agent: "b", status: "waiting" },
					],
				},
			],
		};
		expect(renderProgress(mixed, theme, 0).join("\n")).toContain("1/2 done");

		const runningBeatsFailed: ProgressModel = {
			stages: [
				{
					units: [
						{ id: 0, agent: "a", status: "failed" },
						{ id: 1, agent: "b", status: "running" },
					],
				},
			],
		};
		expect(renderProgress(runningBeatsFailed, theme, 0).join("\n")).toContain("running");

		const cancelledWithDone: ProgressModel = {
			stages: [
				{
					units: [
						{ id: 0, agent: "a", status: "cancelled" },
						{ id: 1, agent: "b", status: "done" },
					],
				},
			],
		};
		expect(renderProgress(cancelledWithDone, theme, 0).join("\n")).toContain("cancelled");
	});
});

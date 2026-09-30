/**
 * Live progress model for a delegation run.
 *
 * The progress widget must show, at a glance, what the orchestrator is doing:
 * which stage is running, which agents are waiting, and which have finished.
 * This module is pure and pi-free (like `render.ts`), so the status machine and
 * the renderer are unit-testable with plain data. The pi edge (`index.ts`) owns
 * the widget registration, the animation timer and width truncation.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { sanitizeUiText } from "./security.js";

/** Per-agent state within a run. */
export type ProgressStatus = "waiting" | "running" | "done" | "failed" | "cancelled";

/** One agent in one stage. */
export interface ProgressUnit {
	id: number;
	agent: string;
	status: ProgressStatus;
}

/** One stage; more than one unit means a parallel group. */
export interface ProgressStage {
	units: ProgressUnit[];
}

export interface ProgressModel {
	stages: ProgressStage[];
}

/** Minimal theme surface (same type-only pi exception as `render.ts`). */
export interface ProgressTheme {
	fg: (color: ThemeColor, text: string) => string;
}

/** Braille spinner frames; the widget advances them on a timer. */
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Build a model from the run's stage grouping (one stage per sequential step). */
export function createProgress(stages: readonly { agents: readonly string[] }[]): ProgressModel {
	let id = 0;
	return {
		stages: stages.map((stage) => ({
			units: stage.agents.map((agent) => ({ id: id++, agent, status: "waiting" as const })),
		})),
	};
}

function findUnit(
	model: ProgressModel,
	stage: number,
	agent: string,
	status?: ProgressStatus,
): ProgressUnit | undefined {
	const units = model.stages[stage]?.units;
	if (!units) return undefined;
	const matches = units.filter((unit) => unit.agent === agent && (status === undefined || unit.status === status));
	return matches[0];
}

/** Mark the stage's next unit for `agent` (or its first waiting unit) running. */
export function markRunning(model: ProgressModel, stage: number, agent: string): void {
	const target = findUnit(model, stage, agent, "waiting") ?? findUnit(model, stage, agent);
	if (target) target.status = "running";
}

/** Settle the running (or still-waiting) unit for `agent`. */
export function markSettled(model: ProgressModel, stage: number, agent: string, ok: boolean): void {
	const target = findUnit(model, stage, agent, "running") ?? findUnit(model, stage, agent, "waiting");
	if (target) target.status = ok ? "done" : "failed";
}

/** Mark every unit still waiting or running as `status` (early stop / cancel). */
export function markRemaining(model: ProgressModel, status: "failed" | "cancelled"): void {
	for (const stage of model.stages) {
		for (const unit of stage.units) {
			if (unit.status === "waiting" || unit.status === "running") unit.status = status;
		}
	}
}

/** Completed and total unit counts across the whole run. */
export function progressCounts(model: ProgressModel): { done: number; total: number } {
	let done = 0;
	let total = 0;
	for (const stage of model.stages) {
		for (const unit of stage.units) {
			total += 1;
			if (unit.status === "done") done += 1;
		}
	}
	return { done, total };
}

/** True while any unit is still waiting or running (so the spinner should spin). */
function isActive(model: ProgressModel): boolean {
	return model.stages.some((stage) =>
		stage.units.some((unit) => unit.status === "waiting" || unit.status === "running"),
	);
}

const GLYPH: Record<ProgressStatus, string> = {
	waiting: "○",
	running: "◐",
	done: "✓",
	failed: "✗",
	cancelled: "⊘",
};

const COLOR: Record<ProgressStatus, ThemeColor> = {
	waiting: "dim",
	running: "accent",
	done: "success",
	failed: "error",
	cancelled: "warning",
};

/** Dominant status of a stage: any running wins, then any failure, then all-done. */
function stageStatus(stage: ProgressStage): ProgressStatus {
	if (stage.units.some((unit) => unit.status === "running")) return "running";
	if (stage.units.some((unit) => unit.status === "failed")) return "failed";
	if (stage.units.every((unit) => unit.status === "done")) return "done";
	if (stage.units.every((unit) => unit.status === "cancelled")) return "cancelled";
	if (
		stage.units.some((unit) => unit.status === "cancelled") &&
		!stage.units.some((unit) => unit.status === "waiting")
	) {
		return "cancelled";
	}
	return "waiting";
}

function stageLabel(stage: ProgressStage): string {
	const status = stageStatus(stage);
	const done = stage.units.filter((unit) => unit.status === "done").length;
	if (status === "waiting" && done > 0) return `${done}/${stage.units.length} done`;
	return status;
}

/** Header + one row per stage, ready for the widget (untruncated). */
export function renderProgress(model: ProgressModel, theme: ProgressTheme, frame: number): string[] {
	const { done, total } = progressCounts(model);
	const active = isActive(model);
	const heading = `● Agents (${done}/${total})`;
	const spinner = active ? `  ${theme.fg("accent", SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "●")}` : "";
	const lines = [`${theme.fg(active ? "accent" : "dim", heading)}${spinner}`];

	model.stages.forEach((stage, index) => {
		const last = index === model.stages.length - 1;
		const status = stageStatus(stage);
		const names = stage.units.map((unit) => sanitizeUiText(unit.agent, 64)).join(", ");
		const branch = theme.fg("dim", last ? "└─" : "├─");
		const glyph = theme.fg(COLOR[status], GLYPH[status]);
		const label = theme.fg("dim", stageLabel(stage));
		lines.push(`${branch} ${glyph} ${names.padEnd(20)} ${label}`);
	});

	return lines;
}

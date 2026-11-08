import { describe, expect, it } from "vitest";
import { CHILD_TELEMETRY_CHANNEL, CHILD_TELEMETRY_EVENTS, childTelemetryEnvelope } from "./telemetry.js";

const sink = { delegationId: "delegation-1", parentSessionId: "session-1" };

describe("CHILD_TELEMETRY_CHANNEL", () => {
	it("is namespaced to this extension", () => {
		expect(CHILD_TELEMETRY_CHANNEL).toBe("mx-pi-agents:child-telemetry");
	});
});

describe("CHILD_TELEMETRY_EVENTS", () => {
	it("covers what a tracer needs to build spans", () => {
		for (const name of [
			"session_start",
			"before_agent_start",
			"context",
			"before_provider_request",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"agent_end",
		]) {
			expect(CHILD_TELEMETRY_EVENTS).toContain(name);
		}
	});

	it("excludes high-frequency streaming events", () => {
		expect(CHILD_TELEMETRY_EVENTS).not.toContain("message_update");
		expect(CHILD_TELEMETRY_EVENTS).not.toContain("tool_execution_update");
	});

	it("lists each event once", () => {
		expect(new Set(CHILD_TELEMETRY_EVENTS).size).toBe(CHILD_TELEMETRY_EVENTS.length);
	});
});

describe("childTelemetryEnvelope", () => {
	it("carries the delegation, run and agent identity", () => {
		const event = { type: "message_end" };
		expect(childTelemetryEnvelope(sink, { runId: "run-1", agent: "explorer" }, event)).toEqual({
			delegationId: "delegation-1",
			parentSessionId: "session-1",
			runId: "run-1",
			agent: "explorer",
			type: "message_end",
			event,
		});
	});

	it("omits the child session id until it is known", () => {
		const envelope = childTelemetryEnvelope(sink, { runId: "run-1", agent: "explorer" }, { type: "agent_start" });
		expect(envelope).not.toHaveProperty("childSessionId");
	});

	it("includes the child session id once known", () => {
		const envelope = childTelemetryEnvelope(
			sink,
			{ runId: "run-1", agent: "explorer", childSessionId: "child-1" },
			{ type: "message_end" },
		);
		expect(envelope.childSessionId).toBe("child-1");
	});

	it("passes the event through by reference", () => {
		const event = { type: "tool_execution_start", toolName: "read" };
		expect(childTelemetryEnvelope(sink, { runId: "run-1", agent: "explorer" }, event).event).toBe(event);
	});
});

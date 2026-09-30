import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CHILD_TELEMETRY_EVENTS, type ChildTelemetryEnvelope } from "../telemetry.js";
import { createChildTelemetryExtension } from "./telemetry.js";

function build(options: { sink?: Partial<{ emit: (envelope: ChildTelemetryEnvelope) => void }> } = {}) {
	const received: ChildTelemetryEnvelope[] = [];
	const sink = {
		delegationId: "delegation-1",
		parentSessionId: "session-1",
		emit: (envelope: ChildTelemetryEnvelope) => received.push(envelope),
		...options.sink,
	};
	const handlers = new Map<string, Array<(event: { type: string }, ctx: unknown) => void>>();
	const pi = {
		on: vi.fn((name: string, handler: (event: { type: string }, ctx: unknown) => void) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		}),
	};
	// SAFETY: the factory only calls `pi.on`; this stub implements exactly that.
	createChildTelemetryExtension({ sink, runId: "run-1", agent: "explorer" })(pi as unknown as ExtensionAPI);
	return {
		received,
		registered: [...handlers.keys()],
		fire: (name: string, event: { type: string }, ctx: unknown = {}) => {
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
		},
	};
}

describe("createChildTelemetryExtension", () => {
	it("registers exactly the forwarded event set", () => {
		expect(build().registered).toEqual([...CHILD_TELEMETRY_EVENTS]);
	});

	it("forwards an event with its identity", () => {
		const { received, fire } = build();
		fire("message_end", { type: "message_end" });
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			delegationId: "delegation-1",
			parentSessionId: "session-1",
			runId: "run-1",
			agent: "explorer",
			type: "message_end",
		});
	});

	it("captures the child session id from session_start", () => {
		const { received, fire } = build();
		fire("session_start", { type: "session_start" }, { sessionManager: { getSessionId: () => "child-1" } });
		fire("message_end", { type: "message_end" });
		expect(received[0].childSessionId).toBe("child-1");
		expect(received[1].childSessionId).toBe("child-1");
	});

	it("leaves the child session id unset when the context has none", () => {
		const { received, fire } = build();
		fire("session_start", { type: "session_start" }, {});
		expect(received[0]).not.toHaveProperty("childSessionId");
	});

	it("swallows a throwing sink", () => {
		const { fire } = build({
			sink: {
				emit: () => {
					throw new Error("phoenix is down");
				},
			},
		});
		expect(() => fire("message_end", { type: "message_end" })).not.toThrow();
	});

	it("swallows a throwing session-id probe", () => {
		const { received, fire } = build();
		expect(() =>
			fire(
				"session_start",
				{ type: "session_start" },
				{
					sessionManager: {
						getSessionId: () => {
							throw new Error("no id");
						},
					},
				},
			),
		).not.toThrow();
		expect(received).toEqual([]);
	});
});

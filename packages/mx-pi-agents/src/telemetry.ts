/**
 * Cross-extension telemetry for child agent runs.
 *
 * A delegation runs in a child `AgentSession` with extensions disabled, so a
 * tracing extension loaded in the parent session (pi-phoenix and friends) never
 * observes the child's provider requests, messages or tool executions. To make
 * child runs traceable without weakening that isolation, the child loads a
 * single *inline* extension — inline factories survive `noExtensions` — that
 * re-publishes its lifecycle events on the parent's shared extension event bus,
 * keyed by delegation and run.
 *
 * The payload carries the raw extension event, so a consumer can reuse the same
 * handler it already runs on the parent session. This module is pure: it names
 * the channel, fixes the event set, and builds envelopes.
 */

/** Event-bus channel carrying {@link ChildTelemetryEnvelope}s. */
export const CHILD_TELEMETRY_CHANNEL = "mx-pi-agents:child-telemetry";

/**
 * Child extension events re-published on the bus. Chosen for span-building
 * fidelity: session framing, the request payload and context a model span
 * needs, finalized assistant messages, and tool executions. Streaming
 * (`message_update`, `tool_execution_update`) is deliberately excluded so a
 * consumer can never be flooded by a bus channel it did not ask for.
 */
export const CHILD_TELEMETRY_EVENTS = [
	"session_start",
	"session_shutdown",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"agent_settled",
	"context",
	"before_provider_request",
	"before_provider_headers",
	"after_provider_response",
	"message_end",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
] as const;

/** One re-published child extension event. */
export interface ChildTelemetryEnvelope {
	/** Shared by every agent that belongs to one delegation call. */
	delegationId: string;
	/** Unique to one child agent run. */
	runId: string;
	/** Named agent definition, e.g. `explorer`. */
	agent: string;
	/** Parent pi session id, so a consumer can group child spans under it. */
	parentSessionId: string;
	/** The child's own session id; known once its `session_start` was seen. */
	childSessionId?: string;
	/** Event name, lifted out of `event.type` for cheap channel filtering. */
	type: string;
	/** The child extension event, verbatim. */
	event: { type: string };
}

/** Where one child run publishes telemetry, supplied by the parent session. */
export interface ChildTelemetrySink {
	/** Shared by every agent in one delegation call. */
	delegationId: string;
	/** Parent pi session id. */
	parentSessionId: string;
	/** Must never throw; a failure to publish must not disturb the child. */
	emit(envelope: ChildTelemetryEnvelope): void;
}

/** Build an envelope for one event of one child run. */
export function childTelemetryEnvelope(
	sink: Pick<ChildTelemetrySink, "delegationId" | "parentSessionId">,
	run: { runId: string; agent: string; childSessionId?: string },
	event: { type: string },
): ChildTelemetryEnvelope {
	const envelope: ChildTelemetryEnvelope = {
		delegationId: sink.delegationId,
		parentSessionId: sink.parentSessionId,
		runId: run.runId,
		agent: run.agent,
		type: event.type,
		event,
	};
	if (run.childSessionId !== undefined) envelope.childSessionId = run.childSessionId;
	return envelope;
}

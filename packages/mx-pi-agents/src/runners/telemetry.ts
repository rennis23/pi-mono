/**
 * The one inline extension a child session loads.
 *
 * Inline extension factories are loaded even when `noExtensions: true`, so this
 * adds no discovery surface: it is constructed in-process by the runner, not
 * discovered from disk. Its only job is to re-publish the child's extension
 * events onto the parent's shared event bus. It registers no tools, so the
 * child's grant set is unchanged.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CHILD_TELEMETRY_EVENTS, type ChildTelemetrySink, childTelemetryEnvelope } from "../telemetry.js";

export interface ChildTelemetryExtensionOptions {
	/** Parent-side publisher; already bound to one delegation. */
	sink: ChildTelemetrySink;
	/** Unique to this child agent run. */
	runId: string;
	/** Named agent definition being run. */
	agent: string;
}

/** Minimal shape of `session_start`'s ctx that this extension reads. */
interface SessionIdContext {
	sessionManager?: { getSessionId?: () => string };
}

/**
 * Build the inline extension for one child run.
 *
 * Every publish is best-effort: telemetry must never break or stall a child,
 * so a throwing sink (or a throwing session-id probe) is swallowed.
 */
export function createChildTelemetryExtension(options: ChildTelemetryExtensionOptions): ExtensionFactory {
	const { sink, runId, agent } = options;
	return (pi: ExtensionAPI) => {
		let childSessionId: string | undefined;

		const forward = (event: { type: string }, ctx?: SessionIdContext) => {
			try {
				if (childSessionId === undefined && event.type === "session_start") {
					childSessionId = ctx?.sessionManager?.getSessionId?.();
				}
				sink.emit(childTelemetryEnvelope(sink, { runId, agent, childSessionId }, event));
			} catch {
				/* telemetry is best-effort and must not disturb the child */
			}
		};

		// SAFETY: every name in CHILD_TELEMETRY_EVENTS is a real extension event, and
		// these handlers are pure observers (they return nothing and mutate nothing),
		// so the widened handler signature is sound for each overload.
		const on = pi.on as unknown as (
			name: string,
			handler: (event: { type: string }, ctx: SessionIdContext) => void,
		) => void;
		for (const name of CHILD_TELEMETRY_EVENTS) on(name, forward);
	};
}

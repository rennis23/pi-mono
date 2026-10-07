import type { SettingsEventBus, SettingsHost } from "../src/sdk-core.js";

export type SessionEvent = "session_start" | "session_shutdown";
type Listener = () => void;

export function createEventBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const events: SettingsEventBus = {
		emit(channel, data) {
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
		on(channel, handler) {
			const channelListeners = listeners.get(channel) ?? new Set<(data: unknown) => void>();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(handler);
		},
	};
	return { events, listeners };
}

export function createHost(initialFlags: Record<string, boolean | string | undefined> = {}) {
	const bus = createEventBus();
	const handlers = new Map<SessionEvent, Set<Listener>>();
	const flags = new Map(Object.entries(initialFlags));
	const host: SettingsHost = {
		events: bus.events,
		on(event, handler) {
			const eventHandlers = handlers.get(event) ?? new Set<Listener>();
			eventHandlers.add(handler);
			handlers.set(event, eventHandlers);
			return () => eventHandlers.delete(handler);
		},
	};
	return {
		host,
		bus,
		flags,
		fire(event: SessionEvent) {
			for (const handler of handlers.get(event) ?? []) handler();
		},
	};
}

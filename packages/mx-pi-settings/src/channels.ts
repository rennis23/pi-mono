/**
 * Event-bus channel names and payload guards for hub ↔ provider traffic.
 *
 * The bus is pi's in-process `pi.events` channel, which is deliberately untyped:
 * a provider and the hub may be built separately, so every payload is validated
 * on arrival instead of trusted.
 *
 * Protocol handshake
 *
 * 1. The hub emits `announce` (in its factory and again on `session_start`).
 * 2. A provider emits `register` (at registration time, and again on every
 *    `announce`).
 * 3. At `session_start`, the hub emits `configure` with parsed flag values;
 *    providers cannot read another extension's `getFlag()` directly.
 *
 * Both sides publish unconditionally because load order is not guaranteed: when
 * a provider loads first its initial `register` reaches nobody, and when the hub
 * loads first its factory-time `announce` reaches nobody. The `session_start`
 * announce runs after every extension has loaded, so it repairs whichever side
 * missed the first exchange.
 */

import type { ProviderIO, RegistrationPayload, SettingsSpec } from "./types.js";

export const PROTOCOL_VERSION = 1;

export const SETTINGS_CHANNELS = {
	/** hub → providers: "I am ready (or reloaded); publish your spec again." */
	announce: "mx-pi-settings:announce",
	/** provider → hub: the spec plus the callbacks that mutate it. */
	register: "mx-pi-settings:register",
	/** provider → hub: this registration is going away. */
	unregister: "mx-pi-settings:unregister",
	/** hub → providers: run-scoped overrides and store path after flag parsing. */
	configure: "mx-pi-settings:configure",
} as const;

export interface AnnouncePayload {
	protocol: number;
	/** Diagnostics only: which extension instance published the announce. */
	hub: string;
}

export interface RuntimeConfigPayload {
	protocol: number;
	/** Raw `--mx-pi-settings-set` value, decoded by each provider against its field spec. */
	assignments?: string;
	/** Store override from `--mx-pi-settings-store`; absent means the default agent path. */
	storePath?: string;
}

export function isRuntimeConfigPayload(value: unknown): value is RuntimeConfigPayload {
	if (!isRecord(value) || value.protocol !== PROTOCOL_VERSION) return false;
	if (value.assignments !== undefined && typeof value.assignments !== "string") return false;
	if (value.storePath !== undefined && typeof value.storePath !== "string") return false;
	return true;
}

export function createAnnouncePayload(hub: string): AnnouncePayload {
	return { protocol: PROTOCOL_VERSION, hub };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cheap structural check: a spec needs an id, a title, and an array of fields. */
export function isSettingsSpec(value: unknown): value is SettingsSpec {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || value.id.length === 0) return false;
	if (typeof value.title !== "string") return false;
	return Array.isArray(value.fields);
}

function isProviderIO(value: unknown): value is ProviderIO {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string") return false;
	return typeof value.read === "function" && typeof value.write === "function" && typeof value.reset === "function";
}

/**
 * Guard for bus payloads. Anything else (including a payload from a future
 * protocol version that added fields we do not know) is rejected so the hub
 * never renders or calls something it cannot trust.
 */
export function isRegistrationPayload(value: unknown): value is RegistrationPayload {
	if (!isRecord(value)) return false;
	return isSettingsSpec(value.spec) && isProviderIO(value.io) && typeof value.protocol === "number";
}

/** Id named by an unregister payload, or `undefined` when the payload is unusable. */
export function readUnregisterId(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) return value.id;
	return undefined;
}

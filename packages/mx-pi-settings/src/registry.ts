/**
 * Hub-side registry for provider specs and their mutation callbacks.
 *
 * The event bus is untyped and multiple extensions can emit the registration
 * channel, so every event is guarded and every callback invocation is isolated
 * from the TUI. One provider's invalid spec or throwing callback cannot take the
 * hub down.
 */

import { isRegistrationPayload, PROTOCOL_VERSION } from "./channels.js";
import { defaultValues, validateSpec } from "./fields.js";
import type { MutationResult, RegistrationPayload, SettingPrimitive, SettingValues } from "./types.js";

export type RegistrationResult = { accepted: true; replaced?: boolean } | { accepted: false; error: string };

export interface SettingsRegistry {
	register(payload: unknown): RegistrationResult;
	unregister(id: string): void;
	clear(): void;
	list(): RegistrationPayload[];
	get(id: string): RegistrationPayload | undefined;
	read(registration: RegistrationPayload): SettingValues;
	write(registration: RegistrationPayload, key: string, value: SettingPrimitive): MutationResult;
	reset(registration: RegistrationPayload, key?: string): MutationResult;
}

function failed(message: string): MutationResult {
	return { ok: false, error: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSettingValues(value: unknown): value is SettingValues {
	if (!isRecord(value)) return false;
	return Object.values(value).every(
		(item) =>
			typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)),
	);
}

function isMutationResult(value: unknown): value is MutationResult {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok ? isSettingValues(value.values) : typeof value.error === "string";
}

export function createSettingsRegistry(): SettingsRegistry {
	const registrations = new Map<string, RegistrationPayload>();

	return {
		register(payload: unknown): RegistrationResult {
			if (!isRegistrationPayload(payload)) return { accepted: false, error: "malformed registration payload" };
			if (payload.protocol !== PROTOCOL_VERSION) {
				return {
					accepted: false,
					error: `unsupported registration protocol ${payload.protocol}; expected ${PROTOCOL_VERSION}`,
				};
			}
			if (payload.io.id !== payload.spec.id)
				return { accepted: false, error: "registration id does not match its callback id" };
			const issue = validateSpec(payload.spec);
			if (issue !== undefined) return { accepted: false, error: issue };
			const previous = registrations.get(payload.spec.id);
			const replaced = previous !== undefined;
			registrations.set(payload.spec.id, payload);
			return { accepted: true, replaced: replaced && previous.io !== payload.io };
		},
		unregister(id: string): void {
			registrations.delete(id);
		},
		clear(): void {
			registrations.clear();
		},
		list(): RegistrationPayload[] {
			return [...registrations.values()].sort((a, b) => {
				const titleOrder = a.spec.title.localeCompare(b.spec.title);
				return titleOrder === 0 ? a.spec.id.localeCompare(b.spec.id) : titleOrder;
			});
		},
		get(id: string): RegistrationPayload | undefined {
			return registrations.get(id);
		},
		read(registration: RegistrationPayload): SettingValues {
			try {
				const values = registration.io.read();
				return isSettingValues(values) ? { ...values } : defaultValues(registration.spec);
			} catch {
				return defaultValues(registration.spec);
			}
		},
		write(registration: RegistrationPayload, key: string, value: SettingPrimitive): MutationResult {
			try {
				const result = registration.io.write(key, value);
				return isMutationResult(result) ? result : failed("provider returned an invalid write result");
			} catch (error) {
				return failed(error instanceof Error ? error.message : String(error));
			}
		},
		reset(registration: RegistrationPayload, key?: string): MutationResult {
			try {
				const result = registration.io.reset(key);
				return isMutationResult(result) ? result : failed("provider returned an invalid reset result");
			} catch (error) {
				return failed(error instanceof Error ? error.message : String(error));
			}
		},
	};
}

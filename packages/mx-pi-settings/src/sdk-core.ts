/** Provider-side registration implementation, separated for deterministic tests. */

import { isRuntimeConfigPayload, PROTOCOL_VERSION, SETTINGS_CHANNELS } from "./channels.js";
import { decodeValue, defaultValues, findField, validateSpec } from "./fields.js";
import { parseFlagAssignments } from "./flags.js";
import { createSettingsStore, getDefaultStorePath, type SettingsStore } from "./store.js";
import type {
	DeclaredSettings,
	MutationResult,
	ProviderIO,
	RegistrationPayload,
	SettingPrimitive,
	SettingsHandle,
	SettingsSpec,
	SettingValues,
} from "./types.js";

export interface SettingsEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface SettingsHost {
	events: SettingsEventBus;
	on(event: "session_shutdown", handler: () => void): () => void;
}

export interface RegisterSettingsOptions {
	store?: SettingsStore;
}

function failed(error: string): MutationResult {
	return { ok: false, error };
}

function succeeded(values: SettingValues): MutationResult {
	return { ok: true, values };
}

function buildOverrides(spec: Pick<SettingsSpec, "id" | "fields">, raw: string | undefined): SettingValues {
	const parsed = parseFlagAssignments(raw);
	const overrides: SettingValues = {};
	for (const assignment of parsed.assignments) {
		if (assignment.id !== spec.id) continue;
		const field = findField(spec, assignment.key);
		if (!field) continue;
		const result = decodeValue(field, assignment.value);
		if (result.ok && result.value !== undefined) overrides[field.key] = result.value;
	}
	return overrides;
}

function readEffectiveValues(
	spec: Pick<SettingsSpec, "id" | "fields">,
	store: SettingsStore,
	overrides: SettingValues,
): SettingValues {
	const defaults = defaultValues(spec);
	const stored = store.readNamespace(spec.id);
	const values: SettingValues = { ...defaults };
	for (const field of spec.fields) {
		const storedValue = stored[field.key];
		if (storedValue !== undefined) {
			const decoded = decodeValue(field, storedValue);
			if (decoded.ok && decoded.value !== undefined) values[field.key] = decoded.value;
		}
		const override = overrides[field.key];
		if (override !== undefined) values[field.key] = override;
	}
	return values;
}

function callOnChange<T extends DeclaredSettings<T>>(
	spec: SettingsSpec<T>,
	values: SettingValues,
	changedKeys: string[],
): void {
	try {
		spec.onChange?.(values as T, changedKeys);
	} catch {
		// Provider callbacks are outside the store's transaction. The value is
		// already saved; a broken render/apply callback must not undo persistence.
	}
}

function createProviderIO<T extends DeclaredSettings<T>>(
	spec: SettingsSpec<T>,
	getStore: () => SettingsStore,
	getOverrides: () => SettingValues,
): ProviderIO {
	function read(): SettingValues {
		return readEffectiveValues(spec, getStore(), getOverrides());
	}

	function write(key: string, value: SettingPrimitive): MutationResult {
		const field = findField(spec, key);
		if (!field) return failed(`unknown setting "${key}" for ${spec.id}`);
		const decoded = decodeValue(field, value);
		if (!decoded.ok) return failed(decoded.error);
		try {
			getStore().patchNamespace(spec.id, { [key]: decoded.value });
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
		const values = read();
		callOnChange(spec, values, [key]);
		return succeeded(values);
	}

	function reset(key?: string): MutationResult {
		const targetFields = key === undefined ? spec.fields : spec.fields.filter((field) => field.key === key);
		if (targetFields.length === 0) return failed(`unknown setting "${key}" for ${spec.id}`);
		const previous = read();
		try {
			const store = getStore();
			if (key === undefined) {
				store.clearNamespace(spec.id);
			} else {
				const stored = store.readNamespace(spec.id);
				delete stored[key];
				store.writeNamespace(spec.id, stored);
			}
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
		const values = read();
		const changedKeys = targetFields
			.filter((field) => previous[field.key] !== values[field.key])
			.map((field) => field.key);
		callOnChange(spec, values, changedKeys);
		return succeeded(values);
	}

	return { id: spec.id, read, write, reset };
}

/**
 * Register one provider spec and create the typed handle. A host-supplied store
 * is injectable for tests; extensions should use the public `registerSettings`
 * wrapper in `sdk.ts`. Runtime flags arrive from the hub over the event bus,
 * because `pi.getFlag()` is scoped to the extension that registered each flag.
 */
export function registerSettingsCore<T extends DeclaredSettings<T>>(
	host: SettingsHost,
	spec: SettingsSpec<T>,
	options: RegisterSettingsOptions = {},
): SettingsHandle<T> {
	const issue = validateSpec(spec);
	if (issue !== undefined) throw new Error(`Invalid settings spec "${spec.id}": ${issue}`);
	const runtime = {
		store: options.store ?? createSettingsStore(getDefaultStorePath()),
		overrides: {} as SettingValues,
	};
	const io = createProviderIO(
		spec,
		() => runtime.store,
		() => runtime.overrides,
	);
	const applyRuntimeConfig = (payload: unknown): void => {
		if (!isRuntimeConfigPayload(payload)) return;
		const previous = io.read();
		if (!options.store) {
			const path = payload.storePath?.trim();
			runtime.store = createSettingsStore(path || getDefaultStorePath());
		}
		runtime.overrides = buildOverrides(spec, payload.assignments);
		const values = io.read();
		const changedKeys = spec.fields
			.filter((field) => previous[field.key] !== values[field.key])
			.map((field) => field.key);
		if (changedKeys.length > 0) callOnChange(spec, values, changedKeys);
	};
	const payload: RegistrationPayload = {
		spec: { id: spec.id, title: spec.title, description: spec.description, fields: spec.fields },
		io,
		protocol: PROTOCOL_VERSION,
	};
	let disposed = false;

	const publish = (): void => {
		if (!disposed) host.events.emit(SETTINGS_CHANNELS.register, payload);
	};
	const unsubscribeAnnounce = host.events.on(SETTINGS_CHANNELS.announce, publish);
	const unsubscribeRuntimeConfig = host.events.on(SETTINGS_CHANNELS.configure, applyRuntimeConfig);
	const unsubscribeShutdown = host.on("session_shutdown", () => handle.dispose());
	const handle: SettingsHandle<T> = {
		id: spec.id,
		values: () => io.read() as T,
		get<K extends keyof T & string>(key: K): T[K] {
			return io.read()[key] as T[K];
		},
		set<K extends keyof T & string>(key: K, value: T[K]): MutationResult {
			return io.write(key, value);
		},
		reset(key?: keyof T & string): MutationResult {
			return io.reset(key);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			unsubscribeAnnounce();
			unsubscribeRuntimeConfig();
			unsubscribeShutdown();
			host.events.emit(SETTINGS_CHANNELS.unregister, { id: spec.id });
		},
	};
	publish();
	return handle;
}

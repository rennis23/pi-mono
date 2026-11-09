/**
 * Public contract shared by the mx-pi-settings hub and every extension that
 * registers settings with it.
 *
 * Values are plain JSON-ish primitives on purpose: they travel through pi's
 * in-process event bus, get persisted to one shared JSON document, and are
 * rendered in a TUI list. Anything richer (callbacks, class instances) would not
 * survive the store round-trip.
 *
 * There are two generic parameters in play:
 *
 * - `SettingValues` is the untyped shape used inside the store, on the bus, and
 *   in the UI. Everything internal is written against it.
 * - `T extends DeclaredSettings<T>` is the caller's view. A provider declares
 *   its own value interface once (`registerSettings<MyValues>(pi, spec)`) and
 *   then gets typed `get`/`set` instead of casts.
 */

/** A single persistent value. Exhaustive: anything else cannot round-trip JSON. */
export type SettingPrimitive = boolean | number | string;

/** Untyped values keyed by setting key. The internal currency of this package. */
export type SettingValues = Record<string, SettingPrimitive>;

/**
 * An extension's own view of its values, e.g. `{ visible: boolean; rows: number }`.
 * Providers declare it once at registration so `get`/`set` are typed.
 */
export type DeclaredSettings<T extends object = object> = {
	readonly [K in keyof T]: SettingPrimitive;
};

export type SettingFieldType = "boolean" | "number" | "string" | "select" | "color";

interface SettingFieldBase {
	/** Key inside the store namespace. Lower-case identifier; stable across releases. */
	key: string;
	/** Short label shown in the settings list. */
	label: string;
	/** One-line explanation shown for the highlighted row. */
	description?: string;
}

export interface BooleanSettingField extends SettingFieldBase {
	type: "boolean";
	default: boolean;
	/** Value shown for `true` in the UI. Defaults to `"on"`. */
	trueLabel?: string;
	/** Value shown for `false` in the UI. Defaults to `"off"`. */
	falseLabel?: string;
}

export interface NumberSettingField extends SettingFieldBase {
	type: "number";
	default: number;
	min?: number;
	max?: number;
	/** Reject non-integral input. Defaults to false. */
	integer?: boolean;
	/** Unit suffix rendered after the value, e.g. `"rows"`. */
	unit?: string;
}

export interface StringSettingField extends SettingFieldBase {
	type: "string";
	default: string;
	/** Shown by the inline editor when the value is empty. */
	placeholder?: string;
	/** Trimmed value must not exceed this many characters. */
	maxLength?: number;
}

/**
 * A color value stored as a string. Accepted shapes are `none` (no color) or a
 * hex color (`#rgb` / `#rrggbb`), normalized to lower-case `#rrggbb`.
 */
export interface ColorSettingField extends SettingFieldBase {
	type: "color";
	default: string;
	/** Shown by the inline editor when the value is empty. */
	placeholder?: string;
}

export interface SelectOption {
	value: string;
	/** Label shown instead of the raw value. Defaults to `value`. */
	label?: string;
}

export interface SelectSettingField extends SettingFieldBase {
	type: "select";
	default: string;
	options: readonly SelectOption[];
}

export type SettingField =
	| BooleanSettingField
	| NumberSettingField
	| StringSettingField
	| ColorSettingField
	| SelectSettingField;

/** Everything the hub needs to render and mutate one extension's settings. */
export interface SettingsSpec<T extends DeclaredSettings<T> = SettingValues> {
	/** Store namespace and stable identity. Use the extension id, e.g. `mx-pi-context-stats`. */
	id: string;
	/** Row label in the hub's provider list. */
	title: string;
	/** Shown under the title and as the provider row description. */
	description?: string;
	fields: readonly SettingField[];
	/**
	 * Called after any mutation with the full effective value set and the keys
	 * that changed. May be async-receiving but not awaited for correctness: the
	 * value is already persisted when this runs.
	 */
	onChange?: (values: T, changedKeys: readonly string[]) => void;
}

/**
 * Mutation input is already decoded: text coming from the UI, the CLI, and the
 * store is parsed against the field spec by `src/fields.ts` first, so this
 * layer only has to range- and membership-check it.
 */

/** Result of validating, persisting, and applying one mutation. */
export type MutationResult = { ok: true; values: SettingValues } | { ok: false; error: string };

/**
 * The mutation surface a provider publishes to the hub.
 *
 * The SDK builds this from the spec and the store; it never leaves the process,
 * so it can carry closures. Keeping validation inside the provider means there
 * is exactly one writer per namespace and the provider's `onChange` always
 * fires, including for edits made from the hub.
 */
export interface ProviderIO {
	id: string;
	/** Effective values for every declared field: defaults ⊕ stored ⊕ run overrides. */
	read(): SettingValues;
	/** Validate and persist one key. Returns the new effective values on success. */
	write(key: string, value: SettingPrimitive): MutationResult;
	/** Drop one key (or the whole namespace) back to defaults. */
	reset(key?: string): MutationResult;
}

/** Payload emitted on `mx-pi-settings:register`. */
export interface RegistrationPayload {
	/** Presentation metadata only; callbacks stay private to the registering SDK. */
	spec: Omit<SettingsSpec, "onChange">;
	io: ProviderIO;
	/** Protocol version the sender was built against, for future compatibility. */
	protocol: number;
}

/** Live view of one extension's settings, returned by `registerSettings()`. */
export interface SettingsHandle<T extends DeclaredSettings<T> = SettingValues> {
	/** Namespace this handle owns. */
	readonly id: string;
	/** Effective values for every declared field. */
	values(): T;
	get<K extends keyof T & string>(key: K): T[K];
	/** Validate, persist, and notify. Returns an error message instead of throwing. */
	set<K extends keyof T & string>(key: K, value: T[K]): MutationResult;
	/** Move one key (or the whole namespace) back to its declared default. */
	reset(key?: keyof T & string): MutationResult;
	/** Remove this registration from the hub. Idempotent. */
	dispose(): void;
}

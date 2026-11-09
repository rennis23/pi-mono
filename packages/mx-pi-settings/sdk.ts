/**
 * Public SDK for pi extensions that want their settings managed by the
 * mx-pi-settings hub.
 *
 * Usage:
 *
 * ```ts
 * import { registerSettings } from "@rennis23/mx-pi-settings";
 *
 * interface StatsSettings {
 *   visible: boolean;
 *   historyRows: number;
 * }
 *
 * const settings = registerSettings<StatsSettings>(pi, {
 *   id: "mx-pi-context-stats",
 *   title: "Context stats",
 *   fields: [
 *     { key: "visible", label: "Widget", type: "boolean", default: true },
 *     { key: "historyRows", label: "History rows", type: "number", default: 5, min: 1, max: 20 },
 *   ],
 *   onChange(values) { state.options = { ...state.options, ...values }; },
 * });
 *
 * settings.get("historyRows");
 * settings.set("historyRows", 8);
 * ```
 *
 * The SDK is a small wrapper over `pi.events`. It is safe if the hub is not
 * loaded: the provider's own defaults still work, and its registration simply
 * has no receiver. The hub's announce handshake makes provider load order
 * irrelevant when both are loaded.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCore } from "./src/sdk-core.js";
import type { DeclaredSettings, SettingsHandle, SettingsSpec } from "./src/types.js";

/** Register the spec and obtain a typed live handle to its stored values. */
export function registerSettings<T extends DeclaredSettings<T>>(
	pi: ExtensionAPI,
	spec: SettingsSpec<T>,
): SettingsHandle<T> {
	return registerSettingsCore(pi, spec);
}

export type {
	BooleanSettingField,
	ColorSettingField,
	DeclaredSettings,
	MutationResult,
	NumberSettingField,
	ProviderIO,
	SelectOption,
	SelectSettingField,
	SettingField,
	SettingFieldType,
	SettingPrimitive,
	SettingsHandle,
	SettingsSpec,
	SettingValues,
	StringSettingField,
} from "./src/types.js";

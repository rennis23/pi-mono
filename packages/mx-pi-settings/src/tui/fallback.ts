/** Dialog-based settings editor for RPC clients that have UI but no terminal component support. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cycleToValue, type DecodeResult, decodeValue, formatValue } from "../fields.js";
import type { SettingsRegistry } from "../registry.js";
import type { RegistrationPayload, SettingField, SettingPrimitive } from "../types.js";

function valueLabel(registration: RegistrationPayload, registry: SettingsRegistry, field: SettingField): string {
	const value = registry.read(registration)[field.key] ?? field.default;
	return formatValue(field, value as SettingPrimitive);
}

/** Keep editing registered settings through RPC's supported select/input dialogs. */
export async function openSettingsFallback(ctx: ExtensionContext, registry: SettingsRegistry): Promise<void> {
	while (true) {
		const registrations = registry.list();
		if (registrations.length === 0) {
			ctx.ui.notify("No extensions have registered settings yet.", "info");
			return;
		}
		const providerOptions = registrations.map((item) => `${item.spec.title} (${item.spec.id})`);
		const providerChoice = await ctx.ui.select("mx-pi-settings — select extension", providerOptions);
		if (providerChoice === undefined) return;
		const registration = registrations[providerOptions.indexOf(providerChoice)];
		if (!registration) continue;

		while (true) {
			const fieldOptions = [
				...registration.spec.fields.map(
					(field) => `${field.label} [${field.key}] — ${valueLabel(registration, registry, field)}`,
				),
				"← Back to extensions",
			];
			const fieldChoice = await ctx.ui.select(registration.spec.title, fieldOptions);
			if (fieldChoice === undefined) return;
			if (fieldChoice === "← Back to extensions") break;
			const fieldIndex = fieldOptions.indexOf(fieldChoice);
			const field = registration.spec.fields[fieldIndex];
			if (!field) continue;

			const current = registry.read(registration)[field.key] ?? field.default;
			let rawValue: string | undefined;
			if (field.type === "boolean") {
				const labels = [field.trueLabel ?? "on", field.falseLabel ?? "off"];
				const selected = await ctx.ui.select(`${field.label} (${String(current)})`, labels);
				if (selected === undefined) continue;
				rawValue = selected;
			} else if (field.type === "select") {
				const labels = field.options.map((option) => option.label ?? option.value);
				const selected = await ctx.ui.select(`${field.label} (${String(current)})`, labels);
				if (selected === undefined) continue;
				rawValue = selected;
			} else {
				rawValue = await ctx.ui.input(field.label, String(current));
				if (rawValue === undefined) continue;
			}

			const chosen = field.type === "boolean" || field.type === "select" ? cycleToValue(field, rawValue) : undefined;
			const decoded: DecodeResult =
				chosen === undefined ? decodeValue(field, rawValue) : { ok: true, value: chosen };
			if (!decoded.ok) {
				ctx.ui.notify(`Invalid ${field.label}: ${decoded.error}`, "warning");
				continue;
			}
			const result = registry.write(registration, field.key, decoded.value);
			if (!result.ok) {
				ctx.ui.notify(`Could not update ${field.label}: ${result.error}`, "warning");
				continue;
			}
			ctx.ui.notify(`${registration.spec.id}.${field.key}=${formatValue(field, decoded.value)}`, "info");
		}
	}
}

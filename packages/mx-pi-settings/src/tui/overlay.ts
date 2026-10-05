/** Interactive, keyboard-first settings overlay for pi's TUI mode. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Input, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { cycleToValue, cycleValues, type DecodeResult, decodeValue, formatValue } from "../fields.js";
import type { SettingsRegistry } from "../registry.js";
import type { RegistrationPayload, SettingField, SettingPrimitive } from "../types.js";
import { createFrame, DEFAULT_BACKGROUND_COLOR, settingsBackground } from "./frame.js";

function fieldInputSubmenu(
	field: SettingField,
	currentValue: string,
	done: (value?: string) => void,
	tui: { requestRender(): void },
	theme: ExtensionContext["ui"]["theme"],
): Component {
	const container = new Container();
	const heading = new Text(theme.fg("accent", theme.bold(field.label)));
	const help = new Text(theme.fg("dim", field.description ?? `Enter a value for ${field.key}`));
	const input = new Input({
		prompt: "> ",
		placeholder: field.type === "string" ? field.placeholder : "Enter a number",
		placeholderStyle: (text) => theme.fg("dim", text),
	});
	input.focused = true;
	input.setValue(currentValue);
	// pi-tui Input.setValue preserves its existing cursor (initially column 0),
	// so explicitly move to the end for the expected prefilled-input behavior.
	input.handleInput("\x05");
	const errorText = new Text("");
	container.addChild(heading);
	container.addChild(help);
	container.addChild(new Spacer(1));
	container.addChild(input);
	container.addChild(errorText);
	container.addChild(new Text(theme.fg("dim", "enter save • esc cancel")));

	input.onSubmit = (raw) => {
		const result = decodeValue(field, raw);
		if (!result.ok) {
			errorText.setText(theme.fg("error", result.error));
			container.invalidate();
			tui.requestRender();
			return;
		}
		done(String(result.value));
	};
	input.onEscape = () => done(undefined);

	return {
		render(width: number) {
			return container.render(width);
		},
		invalidate() {
			container.invalidate();
		},
		handleInput(data: string) {
			input.handleInput(data);
			container.invalidate();
			tui.requestRender();
		},
	};
}

function providerItems(
	registration: RegistrationPayload,
	registry: SettingsRegistry,
	tui: { requestRender(): void },
	theme: ExtensionContext["ui"]["theme"],
) {
	const values = registry.read(registration);
	return registration.spec.fields.map((field) => {
		const value = values[field.key] ?? field.default;
		const formatted = formatValue(field, value as SettingPrimitive);
		const choices = cycleValues(field);
		return {
			id: field.key,
			label: field.label,
			currentValue: choices ? formatted : String(value),
			description: field.description,
			values: choices,
			...(choices === undefined
				? {
						submenu: (current: string, done: (selectedValue?: string) => void) =>
							fieldInputSubmenu(field, current, done, tui, theme),
					}
				: {}),
		};
	});
}

function changedCount(registration: RegistrationPayload, registry: SettingsRegistry): string {
	const values = registry.read(registration);
	const changed = registration.spec.fields.filter((field) => values[field.key] !== field.default).length;
	return changed === 0 ? "defaults" : `${changed} changed`;
}

export interface SettingsOverlayOptions {
	/** Preselect a provider row by id. */
	focusId?: string;
	/** Current overlay background color; `none` disables the tint. */
	backgroundOf?: () => string;
}

/** Open the custom settings screen. Caller must ensure `ctx.mode === "tui"`. */
export async function openSettingsOverlay(
	ctx: ExtensionContext,
	registry: SettingsRegistry,
	options: SettingsOverlayOptions = {},
): Promise<void> {
	const { focusId, backgroundOf } = options;
	const registrations = registry.list();
	const result = await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const content = new Container();
			// Recomputed on mutation so editing the appearance row repaints the panel live.
			let background = settingsBackground(theme, backgroundOf?.() ?? DEFAULT_BACKGROUND_COLOR);
			const paint = (text: string) => background(text);
			content.addChild(new Text(theme.fg("accent", theme.bold("mx-pi-settings"))));
			content.addChild(
				new Text(
					theme.fg("dim", `${registrations.length} extension${registrations.length === 1 ? "" : "s"} registered`),
				),
			);
			content.addChild(new Spacer(1));

			let handleInput: (data: string) => void;

			if (registrations.length === 0) {
				content.addChild(new Text(theme.fg("muted", "No extensions have registered settings yet.")));
				content.addChild(new Text(theme.fg("dim", "See the mx-pi-settings SDK to publish your settings.")));
				content.addChild(new Spacer(1));
				content.addChild(new Text(theme.fg("dim", "esc close")));
				handleInput = (data: string) => {
					if (data === "\u001b" || data === "q") done(undefined);
				};
			} else {
				let rootSettingsList: SettingsList | undefined;
				const items = registrations.map((registration) => ({
					id: registration.spec.id,
					label: registration.spec.title,
					currentValue: changedCount(registration, registry),
					description: registration.spec.description ?? registration.spec.id,
					submenu: (_current: string, submenuDone: (selectedValue?: string) => void) => {
						const fields = providerItems(registration, registry, tui, theme);
						const list = new SettingsList(
							fields,
							Math.min(fields.length, 12),
							getSettingsListTheme(),
							(key, selectedValue) => {
								const field = registration.spec.fields.find((item) => item.key === key);
								if (!field) return;
								const converted = cycleToValue(field, selectedValue);
								const decoded: DecodeResult =
									converted === undefined ? decodeValue(field, selectedValue) : { ok: true, value: converted };
								if (!decoded.ok) {
									ctx.ui.notify(decoded.error, "warning");
									return;
								}
								const mutation = registry.write(registration, key, decoded.value);
								if (!mutation.ok) {
									ctx.ui.notify(mutation.error, "warning");
									const current = registry.read(registration)[key] ?? field.default;
									list.updateValue(
										key,
										cycleValues(field) ? formatValue(field, current as SettingPrimitive) : String(current),
									);
									return;
								}
								const current = mutation.values[key] ?? field.default;
								list.updateValue(
									key,
									cycleValues(field) ? formatValue(field, current as SettingPrimitive) : String(current),
								);
								rootSettingsList?.updateValue(registration.spec.id, changedCount(registration, registry));
								background = settingsBackground(theme, backgroundOf?.() ?? DEFAULT_BACKGROUND_COLOR);
								tui.requestRender();
								content.invalidate();
							},
							() => submenuDone(undefined),
						);
						return list;
					},
				}));
				const settingsList = new SettingsList(
					items,
					Math.min(items.length, 12),
					getSettingsListTheme(),
					() => {},
					() => done(undefined),
					{ enableSearch: true },
				);
				rootSettingsList = settingsList;
				if (focusId) settingsList.selectItem(focusId);
				content.addChild(settingsList);
				content.addChild(new Spacer(1));
				content.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter edit • / search • esc close")));
				handleInput = (data: string) => {
					settingsList.handleInput(data);
					tui.requestRender();
				};
			}

			const frame = createFrame(content, theme, paint);
			return {
				render: (width: number) => frame.render(width),
				invalidate: () => frame.invalidate(),
				handleInput,
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center", margin: 2 },
		},
	);
	void result;
}

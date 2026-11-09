/**
 * mx-pi-settings hub extension.
 *
 * Providers declare their settings through the SDK exported from this package.
 * This extension renders the registered settings in pi's TUI and persists them
 * through each provider's validated callback surface.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSettings } from "./sdk.js";
import {
	createAnnouncePayload,
	isRegistrationPayload,
	PROTOCOL_VERSION,
	readUnregisterId,
	SETTINGS_CHANNELS,
} from "./src/channels.js";
import { executeSettingsCommand, parseSettingsCommand, SETTINGS_USAGE } from "./src/commands.js";
import { decodeValue, findField } from "./src/fields.js";
import { parseFlagAssignments, SETTINGS_FLAGS } from "./src/flags.js";
import { createSettingsRegistry } from "./src/registry.js";
import { openSettingsFallback } from "./src/tui/fallback.js";
import { DEFAULT_BACKGROUND_COLOR } from "./src/tui/frame.js";
import { openSettingsOverlay } from "./src/tui/overlay.js";
import type { SettingsHandle, SettingsSpec } from "./src/types.js";

const EXTENSION_ID = "mx-pi-settings";

/** The hub's own settings, exposed as an ordinary provider row in the overlay. */
interface HubAppearance {
	background: string;
}

const HUB_APPEARANCE_SPEC: SettingsSpec<HubAppearance> = {
	id: EXTENSION_ID,
	title: "mx-pi-settings",
	description: "Appearance of this settings overlay",
	fields: [
		{
			key: "background",
			label: "Background",
			type: "color",
			default: DEFAULT_BACKGROUND_COLOR,
			description: 'Panel background: a hex color (e.g. #ffb3b3) or "none" to disable the tint',
		},
	],
};

function announce(pi: ExtensionAPI): void {
	pi.events.emit(SETTINGS_CHANNELS.announce, createAnnouncePayload(EXTENSION_ID));
}

function sendRuntimeConfig(pi: ExtensionAPI): void {
	const assignments = pi.getFlag(SETTINGS_FLAGS.set);
	const storePath = pi.getFlag(SETTINGS_FLAGS.store);
	pi.events.emit(SETTINGS_CHANNELS.configure, {
		protocol: PROTOCOL_VERSION,
		...(typeof assignments === "string" ? { assignments } : {}),
		...(typeof storePath === "string" && storePath.trim() ? { storePath: storePath.trim() } : {}),
	});
}

function warnInvalidAssignments(
	ctx: ExtensionContext,
	value: boolean | string | undefined,
	registry: ReturnType<typeof createSettingsRegistry>,
): void {
	if (typeof value !== "string") return;
	const parsed = parseFlagAssignments(value);
	for (const error of parsed.errors) ctx.ui.notify(`mx-pi-settings: ${error}`, "warning");
	for (const assignment of parsed.assignments) {
		const registration = registry.get(assignment.id);
		if (!registration) {
			ctx.ui.notify(`mx-pi-settings: no settings registered for "${assignment.id}"`, "warning");
			continue;
		}
		const field = findField(registration.spec, assignment.key);
		if (!field) {
			ctx.ui.notify(`mx-pi-settings: unknown setting "${assignment.id}.${assignment.key}"`, "warning");
			continue;
		}
		const result = decodeValue(field, assignment.value);
		if (!result.ok) {
			ctx.ui.notify(`mx-pi-settings: invalid ${assignment.id}.${assignment.key}: ${result.error}`, "warning");
		}
	}
}

async function openUI(
	ctx: ExtensionCommandContext,
	registry: ReturnType<typeof createSettingsRegistry>,
	appearance: SettingsHandle<HubAppearance>,
): Promise<void> {
	if (ctx.mode === "tui") {
		await openSettingsOverlay(ctx, registry, { backgroundOf: () => appearance.get("background") });
		return;
	}
	if (ctx.hasUI) {
		await openSettingsFallback(ctx, registry);
		return;
	}
	const result = executeSettingsCommand({ kind: "list" }, registry);
	ctx.ui.notify(result.text, result.type);
}

export default function mxPiSettings(pi: ExtensionAPI): void {
	pi.registerFlag(SETTINGS_FLAGS.open, {
		type: "boolean",
		description: "Open the mx-pi-settings TUI when the pi session starts",
	});
	pi.registerFlag(SETTINGS_FLAGS.set, {
		type: "string",
		description: 'Run-scoped registered-setting overrides: "extension.key=value[,extension.key=value…]"',
	});
	pi.registerFlag(SETTINGS_FLAGS.store, {
		type: "string",
		description: "Override the mx-pi-settings JSON store path for this run",
	});

	const registry = createSettingsRegistry();
	// The hub is also a provider: its appearance settings ride the same registration,
	// store, and overlay paths as every other extension's settings.
	const appearance = registerSettings<HubAppearance>(pi, HUB_APPEARANCE_SPEC);
	let currentCtx: ExtensionContext | undefined;
	let collectingStartupRegistrations = false;
	const warnedDuplicates = new Set<string>();

	pi.events.on(SETTINGS_CHANNELS.register, (payload) => {
		if (!isRegistrationPayload(payload)) {
			currentCtx?.ui.notify("mx-pi-settings: ignored malformed settings registration", "warning");
			return;
		}
		const result = registry.register(payload);
		if (!result.accepted) {
			currentCtx?.ui.notify(`mx-pi-settings: ignored ${payload.spec.id}: ${result.error}`, "warning");
			return;
		}
		if (result.replaced && !warnedDuplicates.has(payload.spec.id)) {
			warnedDuplicates.add(payload.spec.id);
			currentCtx?.ui.notify(
				`mx-pi-settings: duplicate provider id "${payload.spec.id}" replaced the earlier registration`,
				"warning",
			);
		}
		if (currentCtx && !collectingStartupRegistrations) sendRuntimeConfig(pi);
	});
	pi.events.on(SETTINGS_CHANNELS.unregister, (payload) => {
		const id = readUnregisterId(payload);
		if (id) registry.unregister(id);
	});

	// Factory-time announce catches providers that were already listening;
	// session_start sends a second announce after all providers have loaded.
	announce(pi);

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		collectingStartupRegistrations = true;
		try {
			announce(pi);
		} finally {
			collectingStartupRegistrations = false;
		}
		sendRuntimeConfig(pi);
		warnInvalidAssignments(ctx, pi.getFlag(SETTINGS_FLAGS.set), registry);
		if (pi.getFlag(SETTINGS_FLAGS.open) === true) {
			if (ctx.mode === "tui") {
				await openSettingsOverlay(ctx, registry, { backgroundOf: () => appearance.get("background") });
			} else ctx.ui.notify("--mx-pi-settings-open is only available in TUI mode.", "warning");
		}
	});
	pi.on("session_shutdown", async () => {
		registry.clear();
		warnedDuplicates.clear();
		currentCtx = undefined;
	});

	pi.registerCommand("mx-pi-settings", {
		description: "View and edit settings registered by mx-pi extensions",
		handler: async (args, ctx) => {
			const parsed = parseSettingsCommand(args);
			const result = executeSettingsCommand(parsed, registry);
			if (result.openUI) {
				await openUI(ctx, registry, appearance);
				return;
			}
			if (result.text.length > 0) ctx.ui.notify(result.text, result.type);
		},
	});

	pi.registerCommand("mx-pi-settings-help", {
		description: "Show mx-pi-settings command usage",
		handler: async (_args, ctx) => ctx.ui.notify(SETTINGS_USAGE, "info"),
	});
}

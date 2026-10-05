# @rennis23/mx-pi-settings

A central settings hub for pi.dev extensions. Extensions register their own
setting fields; the hub exposes them in one searchable TUI overlay and stores
them in a single namespaced JSON file. It deliberately manages **only settings
registered by extensions**. It does not edit pi's own `settings.json`, manage
extension enable/disable, or replace `pi config`.

## Install

```bash
pi install npm:@rennis23/mx-pi-settings
```

Requires pi ≥ 0.80 and Node.js 22+.

## Use the hub

Run `/mx-pi-settings` to open the TUI overlay. Type to search, use arrows to
select, Enter to open an extension's setting group, and Esc to go back or close.
Boolean and select fields cycle in place; number and string fields open an inline
editor. The overlay is a fully bordered panel whose background is configurable:
open the `mx-pi-settings` row and set `background` to a hex color (e.g.
`#ffb3b3`) or `none` to disable the tint. The value is saved to the central
store and restored on the next session.

| Command | Effect |
| --- | --- |
| `/mx-pi-settings` | Open the overlay (TUI), dialog flow (RPC), or list registered settings |
| `/mx-pi-settings list [id]` | List every provider or one provider's values |
| `/mx-pi-settings get <id>[.<key>]` | Read current effective values, including run overrides |
| `/mx-pi-settings set <id>.<key> <value>` | Validate, persist, and apply one value |
| `/mx-pi-settings reset <id>[.<key>]` | Return one key or a whole provider namespace to defaults |
| `/mx-pi-settings help` | Show usage |

Values persist to `<agentDir>/extensions/mx-pi-settings.json` (where the agent
directory respects `PI_CODING_AGENT_DIR`). Writes are atomic, and each extension
owns its own namespace.

## Register settings from an extension

Add the SDK as a package dependency:

```json
{
  "dependencies": {
    "@rennis23/mx-pi-settings": "^0.1.0"
  }
}
```

Then declare the value type and fields in the extension factory:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettings } from "@rennis23/mx-pi-settings";

interface MyOptions {
  enabled: boolean;
  historyRows: number;
  placement: "aboveEditor" | "belowEditor";
}

export default function myExtension(pi: ExtensionAPI) {
  const options: MyOptions = {
    enabled: true,
    historyRows: 5,
    placement: "belowEditor",
  };

  const settings = registerSettings<MyOptions>(pi, {
    id: "mx-pi-example",
    title: "Example extension",
    description: "Controls the example widget.",
    fields: [
      { key: "enabled", label: "Widget", type: "boolean", default: true },
      { key: "historyRows", label: "History rows", type: "number", default: 5, min: 1, max: 20, integer: true },
      {
        key: "placement",
        label: "Placement",
        type: "select",
        default: "belowEditor",
        options: [
          { value: "aboveEditor", label: "Above editor" },
          { value: "belowEditor", label: "Below editor" },
        ],
      },
    ],
    onChange(values) {
      Object.assign(options, values);
      // Re-render/reconfigure your extension here if necessary.
    },
  });

  pi.on("session_start", async () => {
    Object.assign(options, settings.values());
  });
}
```

The field types are `boolean`, `number`, `string`, `select`, and `color`.
Defaults are required. Numbers can specify `min`, `max`, and `integer`; strings
can specify `maxLength` and `placeholder`; colors accept `none` or a hex color
(`#rgb` / `#rrggbb`, normalized to lower-case `#rrggbb`); booleans can specify
`trueLabel`/`falseLabel`; selects provide a list of `{ value, label? }` options.
IDs are stable namespace keys using lower-case letters, digits, and dashes; field
keys use letters, digits, underscores, and dashes.

`registerSettings()` returns a typed handle:

- `values()` and `get(key)` read defaults, persisted values, and run overrides.
- `set(key, value)` validates and persists; `onChange` receives the effective
  values after persistence.
- `reset(key?)` drops a field or namespace back to its default.
- `dispose()` unregisters; it is safe to call more than once.

The helper handles load order through an announce handshake. The hub broadcasts
run-scoped CLI overrides and the optional store path over a second event after
pi has resolved extension flags; providers do not duplicate flag registrations
(`pi.getFlag()` is scoped to the extension that registered a flag). If the hub
is not loaded, a provider keeps using its own defaults and registration has no
receiver. Callbacks remain inside the extension process; the hub receives only
the spec and a small read/write/reset interface.

## CLI flags

| Flag | Effect |
| --- | --- |
| `--mx-pi-settings-open` | Open the hub on TUI session start |
| `--mx-pi-settings-set "id.key=value,…"` | Apply run-scoped overrides; values are not persisted |
| `--mx-pi-settings-store <path>` | Use a different store path for this invocation |

Run overrides take precedence over persisted values and defaults for that
invocation. For example:

```bash
pi --mx-pi-settings-set 'mx-pi-example.historyRows=8' -e npm:@rennis23/mx-pi-settings
```

A quoted value can contain commas: `--mx-pi-settings-set 'mx-pi-example.label="one,two"'`.

## Modes

- **TUI:** custom overlay with searchable provider list and per-provider field
  screen.
- **RPC:** supported `select`, `input`, and notification dialogs; no custom
  terminal component is required.
- **JSON/print:** commands return text through pi's UI notification abstraction;
  the extension does not write directly to stdout and therefore cannot corrupt
  machine-readable RPC output.

## Security

This extension and all providers run with the permissions of the pi host
process. See [SECURITY.md](./SECURITY.md) for trust boundaries, enforced
validation, residual risks, and reporting guidance.

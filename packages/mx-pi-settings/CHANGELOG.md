# Changelog

## [Unreleased]

- Initial version: central settings hub (`/mx-pi-settings`) with a searchable
  TUI overlay, scriptable subcommands, `--mx-pi-settings-*` CLI flags, and the
  `registerSettings()` SDK other mx-pi extensions use to publish their options.
- Configurable overlay background: the hub exposes itself as an `mx-pi-settings`
  row with a `background` setting (a hex color or `none`), persisted in the
  central store.
- New `color` SDK field type that accepts `none` or a hex color.

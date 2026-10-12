# Changelog

## [Unreleased]

- Tool entries in `tools` now accept `+name` and `-name`, applied in list order on
  top of the selection active when the switch runs, so a definition can change the
  tool selection instead of replacing it (matching pi 1.1.0's `defaultTools`
  entries). Plain names still form an exact preset, `[]` still means no tools, and
  a declared name that does not resolve in the main session still refuses the whole
  switch. `/mx-pi-agents status` shows the declared entries next to the resolved
  selection, and the switch entry persists them as `declared`.
- Registers the `defaultPersona` setting with `@rennis23/mx-pi-settings`.
- Removed from the `agents-v1-patch-3` template: subagent execution, the
  `mx_pi_agent` tool, `#[…]` pipelines, budgets, sandboxing, path scope,
  telemetry and the progress widget.

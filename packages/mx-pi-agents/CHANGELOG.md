# Changelog

## [Unreleased]

- Initial extraction: main-session persona switching with preset and resource
  filters. Definitions use `system_prompt: replace|append`, support `tools`,
  `skills`, `context_files`, `model` and `thinking`, and are switched with
  `#name [task]` / `#none`.
- Registers the `defaultPersona` setting with `@rennis23/mx-pi-settings`.
- Removed from the `agents-v1-patch-3` template: subagent execution, the
  `mx_pi_agent` tool, `#[…]` pipelines, budgets, sandboxing, path scope,
  telemetry and the progress widget.

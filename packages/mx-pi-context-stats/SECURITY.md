# Security — mx-pi-context-stats

## Threat model

This extension runs inside the pi host process and receives session events,
usage data, tool progress, configuration values, and user-provided command
arguments. Its configuration file is local data under the pi agent directory.

### Assets and boundaries

| Boundary | Input | Control |
| --- | --- | --- |
| B1: config file → extension | Local JSON controlled by the user or another local process | Parse failures and unknown values fall back to safe defaults; numeric and enum values are bounded |
| B2: command/CLI input → options | User-provided command arguments and flags | Options are parsed and clamped before rendering or persistence |
| B3: pi events → widget/status | Session usage and tool-progress payloads | Payloads are parsed tolerantly; unmeasurable values are omitted rather than fabricated |
| B4: extension → filesystem | Configuration persistence | Only the extension’s config path is written; the path is derived from pi’s agent directory |
| B5: extension → terminal UI | Names, models, tool labels, and diagnostics | Rendering helpers format bounded values and avoid replacing pi’s native footer |

## Enforced protections

- Malformed, unreadable, or non-object configuration is ignored and does not
  prevent startup.
- Numeric settings are clamped to their supported ranges, invalid placement
  values are ignored, and unknown configuration keys are discarded.
- Configuration writes are limited to the extension-specific JSON file under
  the active pi agent directory. Tests inject a temporary path and do not use a
  real user directory.
- Usage and progress data are treated as optional. Missing or invalid metrics
  are omitted instead of rendering `NaN`, `Infinity`, or misleading zeroes.
- Runtime state is held in memory for the current session and is reset through
  the extension command; it is not written into the target project.
- The package artifact is checked by the repository package-policy gate and
  excludes tests, fixtures, local configuration, and development reports.

The implementation and co-located tests are the authoritative evidence for
these controls, especially `src/config.test.ts`, `src/options.test.ts`,
`src/health.test.ts`, `src/format.test.ts`, and `index.test.ts`.

## Not enforced

- The extension does not isolate itself from the pi host process. A malicious
  or compromised host can inspect or modify its state.
- It does not authenticate local filesystem writers or protect the config file
  from another process that can write the same agent directory.
- It does not validate the trustworthiness of model, provider, tool, or
  subagent data supplied by pi.
- It does not provide process-level sandboxing, network isolation, or a policy
  engine for host tools.
- Terminal safety depends on the pi TUI and the data supplied by the host; this
  package is not a security boundary for arbitrary terminal output.

## Residual risk

A local process with write access to the pi agent directory can change options
or replace the configuration between reads. This can alter presentation and
persistence behavior but does not grant the extension new host capabilities.
The extension inherits the permissions and trust of the pi process in which it
runs.

## Reporting

Please report vulnerabilities privately through the repository security policy
rather than opening a public issue. Include the affected package/version, a
reproduction, the input or boundary involved, and the expected versus observed
behavior. See the repository-level `SECURITY.md` for the reporting route.

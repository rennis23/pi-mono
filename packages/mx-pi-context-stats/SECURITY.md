# Security — mx-pi-context-stats

## Threat model

This extension runs inside the pi host process and receives session events,
usage data, tool progress, registered configuration values, and user-provided
command arguments. Its registered settings are stored by the mx-pi-settings hub
in a shared JSON document under the pi agent directory.

### Assets and boundaries

| Boundary | Input | Control |
| --- | --- | --- |
| B1: shared settings store → extension | Local JSON controlled by the user or another local process | The hub parses the file and validates values against registered field bounds and enum options |
| B2: hub SDK → options | Provider's typed settings handle and `onChange` callback | Values are limited to the registered scalar fields and passed through `withOptions` before use |
| B3: pi events → widget/status | Session usage and tool-progress payloads | Payloads are parsed tolerantly; unmeasurable values are omitted rather than fabricated |
| B4: extension → filesystem | Configuration persistence | The settings hub writes the namespaced shared file under pi's agent directory using atomic replacement |
| B5: extension → terminal UI | Names, models, tool labels, and diagnostics | Rendering helpers format bounded values and avoid replacing pi’s native footer |

## Enforced protections

- Malformed, unreadable, or non-object shared settings are ignored by the hub
  and do not prevent startup.
- Registered numeric settings are bounded by their field specs, invalid
  placement values are rejected by select membership, and unknown registration
  keys are not exposed in the UI.
- The extension writes settings only through its registered SDK handle; the hub
  owns the shared file path and atomic writes. Tests inject a temporary agent
  directory and do not use a real user directory.
- Usage and progress data are treated as optional. Missing or invalid metrics
  are omitted instead of rendering `NaN`, `Infinity`, or misleading zeroes.
- Runtime state is held in memory for the current session and is reset through
  the extension command; it is not written into the target project.
- The package artifact is checked by the repository package-policy gate and
  excludes tests, fixtures, local configuration, and development reports.

The implementation and co-located tests are the authoritative evidence for
these controls, especially `src/options.test.ts`, `src/health.test.ts`,
`src/format.test.ts`, and `index.test.ts`.

## Not enforced

- The extension does not isolate itself from the pi host process. A malicious
  or compromised host can inspect or modify its state.
- It does not authenticate local filesystem writers or protect the shared
  settings file from another process that can write the same agent directory.
- It does not validate the trustworthiness of model, provider, tool, or
  subagent data supplied by pi.
- It does not provide process-level sandboxing, network isolation, or a policy
  engine for host tools.
- Terminal safety depends on the pi TUI and the data supplied by the host; this
  package is not a security boundary for arbitrary terminal output.

## Residual risk

A local process with write access to the pi agent directory can change options
or replace the shared settings document between reads. This can alter
presentation and persistence behavior but does not grant the extension new host
capabilities.
The extension inherits the permissions and trust of the pi process in which it
runs.

## Reporting

Please report vulnerabilities privately through the repository security policy
rather than opening a public issue. Include the affected package/version, a
reproduction, the input or boundary involved, and the expected versus observed
behavior. See the repository-level `SECURITY.md` for the reporting route.

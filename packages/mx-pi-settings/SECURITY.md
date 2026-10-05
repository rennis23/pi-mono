# Security — mx-pi-settings

## Threat model

This package has two halves that share one process with the pi host: the **hub**
extension, which renders the settings UI and writes the shared config file, and
the **SDK**, which every participating extension calls to publish its options
and read them back. Signals cross between them over pi's in-process event bus,
and every payload crosses that boundary as untrusted data.

### Assets and boundaries

| Boundary | Input | Control |
| --- | --- | --- |
| B1: config file → store | Local JSON under the pi agent directory, writable by the user or another local process | Malformed, non-object, or unreadable files yield empty state; every value is re-coerced against the declaring spec before use |
| B2: event bus → hub | Registration payloads (`spec` + mutation callbacks) from any loaded extension | Payloads are structurally guarded: specs are validated (unique keys, known types, in-range defaults) and rejected with a warning instead of being trusted or thrown |
| B3: command/CLI input → values | User-provided command arguments and `--mx-pi-settings-set` assignments | Assignments and arguments are parsed by a tolerant parser, then coerced, clamped, or membership-checked per field before persistence |
| B4: arbitrary provider code → hub UI | A registration's `read`/`write`/`reset` callbacks | Calls are wrapped: throwing or non-conforming callbacks are reported as a failure and cannot break the render loop or stop startup |
| B5: hub → filesystem | Shared settings document | Writes target the resolved store path only (agent directory, or an explicit `--mx-pi-settings-store` override), via write-to-temp plus rename |
| B6: values → terminal UI | Labels, values, and diagnostics from third-party specs | Every rendered line is width-bounded with pi-tui helpers; no value is written into the target project |

## Enforced protections

- A bad config file never blocks startup: missing, unreadable, malformed, or
  non-object documents resolve to an empty document and defaults are used.
- Every value is validated against its declared field: numbers are bounded and
  optionally integral, selects are membership-checked, strings are trimmed and
  length-capped, booleans accept only a documented set of literals. Rejected
  input is reported and never persisted.
- A registration with an invalid spec is ignored (warned once) rather than
  crashing the hub or the registering extension.
- Only the shared settings document is written. Namespaces are read-modify-write
  so unrelated extensions' namespaces are preserved.
- Unknown keys already stored inside a namespace survive round-trips, so
  upgrading an extension cannot silently drop values the UI does not show.
- Tests inject a temporary store path and never touch a real user directory; the
  package artifact is checked by the repository package-policy gate and excludes
  tests, fixtures, and local configuration.

The implementation and co-located tests are the authoritative evidence for these
controls, especially `src/fields.test.ts`, `src/store.test.ts`,
`src/registry.test.ts`, `src/flags.test.ts`, and `sdk.test.ts`.

## Not enforced

- This package is not a sandbox. Extensions run inside the pi host process with
  host permissions, and any extension can emit bus payloads that claim to be a
  settings registration; the hub validates shape and values, not identity.
- It does not authenticate local filesystem writers or protect the settings file
  from another process that can write the same directory. Concurrent pi
  processes are last-writer-wins.
- It does not encrypt or sign the settings document. Anyone able to read the
  agent directory can read every registered value.
- It does not validate that a provider's callbacks are side-effect free, nor
  that its `onChange` handler is safe to call during a render.
- It does not restrict which pi process or project can use the store path
  override; `--mx-pi-settings-store` is trusted input from whoever starts pi.

## Residual risk

Any local process with write access to the pi agent directory can change shared
settings between reads, influencing how other extensions behave on their next
read. This can alter presentation and behavior but grants no new host capability
beyond what the pi process already has. The hub inherits the permissions and
trust of pi itself, and every registered provider inherits them too.

## Reporting

Please report vulnerabilities privately through the repository security policy
rather than opening a public issue. Include the affected package/version, a
reproduction, the boundary involved (B1–B6 above), and the expected versus
observed behavior. See the repository-level `SECURITY.md` for the reporting
route.

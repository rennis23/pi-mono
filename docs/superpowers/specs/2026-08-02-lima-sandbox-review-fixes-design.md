# Design: Correct Lima Sandbox Review Findings

Date: 2026-08-02
Status: approved

## Goal

Correct three regressions identified in the Lima sandbox review without changing
its persistent-instance model or removing existing ad-hoc file support:

1. Reconcile nftables when transitioning between offline and online modes.
2. Store staged single-file ad-hoc mounts at persistent per-instance paths.
3. Make Makefile launch, stop, and delete targets use the same instance name.

## Design

### Offline/online firewall reconciliation

The boot provision script will explicitly reconcile both states:

- When `OFFLINE=true`, remove/recreate the `pi_offline` table in an idempotent
  way with loopback and established/related traffic allowed and output policy
  set to drop.
- When `OFFLINE=false`, remove the `pi_offline` table if it exists.
- Missing-table deletion must not make boot fail.

This ensures repeated offline boots, online transitions, and subsequent offline
transitions all converge to the requested state.

### Persistent staging for single-file mounts

Single-file `--skill` and `--extension` arguments will continue to be supported.
Their copies will be stored below a stable per-instance staging root, rather
than a temporary directory:

```text
$LIMA_HOME/<instance>/adhoc-files/
```

Each staged file receives a stable numbered path under that root. The path is
then injected into the instance mount configuration and remains valid across
launches and VM restarts.

The staging root will be created before `limactl create`. It will not be
removed when the launch process exits. On `--fresh`, the old instance is deleted
and its staging root is removed/recreated as part of the clean-slate flow.

Because Lima cannot modify mounts on an existing instance, supplying new
`--skill` or `--extension` paths to an existing instance will retain the current
warning and instruct the user to use `--fresh` or another instance name. The
existing staged paths remain available without recopying.

### Makefile instance propagation

The `NAME` Make variable will be passed to all launch-oriented targets:

- `pi`
- `pi-offline`
- `pi-fresh`
- `shell`

The same name will therefore be used by launch, stop, and delete. Explicit
`--name` supplied through `PI_ARGS` will be supported with a documented
precedence rule: explicit launch arguments override the Makefile default.

## Error handling

- Firewall cleanup must tolerate an absent nftables table.
- Staging-root creation and file copying must fail with a clear error before
  instance creation if the host path is unavailable or unwritable.
- A failed `limactl create` must not leave a partially configured staging root
  presented as a usable instance.
- Existing-instance mount changes remain warnings/errors rather than silently
  mutating persistent Lima configuration.

## Verification

1. Run `bash -n sandbox/scripts/launch.sh sandbox/scripts/doctor.sh`.
2. Run `git diff --check`.
3. Use mocked `limactl` calls or a Lima VM to verify:
   - offline launch installs the block table;
   - online launch removes it;
   - offline launch after that reinstalls it;
   - staged file paths remain valid after the launcher exits and VM restarts;
   - `--fresh` recreates staging cleanly;
   - `make NAME=testbox pi` launches `testbox`;
   - `make NAME=testbox stop/delete` addresses `testbox`.
4. Run `npm run check` and `npm test` as required by repository policy.

## Scope exclusions

This change does not implement allowlist-based egress filtering, change the
persistent VM model, or add hot-mount support to existing instances.

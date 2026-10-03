# Package Quality and Security Guardians Design

**Date:** 2026-10-03  
**Status:** Approved; implementation in progress
**Scope:** All public extension packages under `packages/`; `sandbox/` is explicitly excluded

## 1. Goal

Make repository quality and security controls apply consistently to every current and future public extension package under `packages/`, rather than relying only on formatting, type checking, and tests. The controls must reduce the chance that an unsafe package, vulnerable dependency, weakly tested change, or unintended file is published.

The design reuses applicable work from `agents-v1-patch-3`, especially:

- the extension good-practices guidance;
- the Stryker/Vitest mutation-testing setup;
- changed-source mutation selection;
- explicit `sandbox/` exclusion.

The branch-specific implementation is generalized. No logic or mutation scope remains tied to `mx-pi-agents`.

## 2. Approved decisions

### 2.1 Enforcement locations

Use both local and centralized enforcement:

- local hooks provide fast feedback and protect normal pushes;
- GitHub pull-request CI is the authoritative merge gate;
- GitHub branch protection must mark the CI jobs as required.

The workflow cannot configure branch protection itself, so the repository documentation must state this operator step.

### 2.2 Mutation cadence

Run changed-source mutation testing on every pull request and local pre-push. Do not make a full all-package mutation run mandatory for every PR.

The full mutation command remains available for manual investigation or future scheduled use.

### 2.3 Security severity

Block high and critical dependency vulnerabilities. Report lower-severity dependency advisories without blocking by default.

Configured CodeQL security findings block the CodeQL job. CodeQL uses the `security-extended` query suite.

### 2.4 Sandbox boundary

Every relevant file glob, test include/exclude rule, mutation rule, CodeQL configuration, package discovery rule, and CI command must exclude `sandbox/`. The sandbox is a smolvm runtime asset tree, not an npm workspace or public extension package.

## 3. Enforcement architecture

### 3.1 Local checks

Keep `pre-commit` focused on the existing formatter, linter, and TypeScript check.

Extend `pre-push` to run:

1. `npm test`;
2. `npm run security:packages`;
3. `npm run security:audit`;
4. `npm run mutation:changed`;
5. local CodeQL when the `codeql` executable is available.

A missing CodeQL executable is reported with installation guidance and does not make the hook unusable for contributors without the optional CLI. The explicit `npm run security:codeql` command is strict and fails if CodeQL is unavailable. A successful CodeQL analysis with one or more configured findings is also a failure: both local and CI paths pass the generated SARIF through the same result checker.

### 3.2 Pull-request CI

Add independent GitHub Actions jobs so failures identify the affected control:

- `quality`: install with `npm ci`, run `npm run check`, and run `npm test`;
- `package-security`: validate package policy and run the high-severity production dependency audit;
- `mutation-changed`: compare against the pull request base SHA and run changed-source mutation;
- `codeql`: analyze JavaScript and TypeScript using the repository CodeQL configuration, retain the SARIF output, and run the repository SARIF gate so findings fail the job;
- `dependency-review`: inspect dependency changes on pull requests and fail on high or critical severity.

All jobs use Node.js 22 and the committed lockfile. Third-party GitHub Actions must be referenced by immutable commit SHA rather than floating tags. The exact action SHAs must be recorded with comments identifying their release versions.

## 4. Package publication policy

Implement a root package-policy validator that discovers direct workspace directories under `packages/` and applies the same rules to each package. It must not traverse or inspect `sandbox/` as a package.

The validator rejects a package when:

- its name does not follow `@rennis23/mx-pi-<name>`;
- it is missing a valid `pi.extensions` entry;
- an extension entry points outside that package;
- the package lacks an explicit `files` allowlist;
- it declares `preinstall`, `install`, `postinstall`, or `prepare` lifecycle scripts;
- required public metadata such as `README.md` or `LICENSE` is missing;
- required release/security documentation is missing;
- the package tarball contains tests, fixtures, `.env` files, repository metadata, reports, local dependencies, generated output, or other development-only content;
- the dry-run artifact contains an unexpected sensitive or repository-only path.

The validator verifies the actual npm artifact with:

```text
npm pack --dry-run --json --workspace <package>
```

It must not reimplement npm’s pack algorithm. It may apply an explicit forbidden-path policy to the dry-run file list and validate that required files are present.

Every public package must ship:

- `README.md`;
- `LICENSE`;
- `CHANGELOG.md` with an `[Unreleased]` section;
- `SECURITY.md` containing threat-model scope, enforced protections, non-enforced protections, residual risk, and reporting instructions.

The current `mx-pi-context-stats` package will be updated to satisfy this policy, including its `files` allowlist. Tests and test harnesses remain excluded from the artifact.

Expose the validator as:

```text
npm run security:packages
```

## 5. Dependency auditing

Expose:

```text
npm run security:audit
npm run security
```

`security` runs package-policy validation, the dependency audit, and strict CodeQL in sequence. The individual commands remain available for focused diagnosis. The command runs npm audit against production-relevant dependencies with a high-severity failure threshold. It must preserve npm’s non-zero failure status and print actionable output.

The CI package-security job runs package validation and the audit after `npm ci`; the CodeQL job runs CodeQL independently. The security aggregate is intended for local use and is not a substitute for the separately reported CI jobs.

## 6. CodeQL

Add a repository CodeQL configuration for JavaScript and TypeScript that:

- uses the `security-extended` suite;
- scans all `packages/` sources, including future packages;
- ignores `sandbox/**`, generated output, mutation output, and SARIF/report directories.

Expose:

```text
npm run security:codeql
```

The local command creates a disposable CodeQL database below an ignored `.codeql/` directory and writes SARIF output there. It must fail clearly when the executable is missing or analysis fails. A shared SARIF-checking helper fails when the result set contains a configured finding, so a clean exit from database analysis cannot hide findings.

The CI job uses the same configuration through the pinned CodeQL GitHub Action, retains its SARIF output, and invokes the shared SARIF checker before uploading or publishing the result. Local and CI scope must remain equivalent even though the database creation mechanisms differ.

## 7. Mutation testing

Generalize the branch’s Stryker configuration from `mx-pi-agents` to all package source:

- mutate `packages/*/index.ts`;
- mutate `packages/*/src/**/*.ts`;
- exclude `*.test.ts`, package test harnesses, generated files, and `sandbox/**`;
- use the TypeScript checker and Vitest runner;
- preserve incremental results and HTML/JSON reports;
- retain an 80% break threshold for the changed mutation run.

Expose:

```text
npm run mutation
npm run mutation:changed
npm run mutation:survivors
```

`mutation:changed` must:

- accept a base Git ref, defaulting to `HEAD`;
- work with package globs rather than only a literal package name;
- include staged, unstaged, and untracked files;
- ignore deleted files, tests, reports, generated files, and `sandbox/`;
- skip Stryker with success when no mutable package source changed;
- forward explicit Stryker arguments safely.

CI passes the pull-request base SHA. Local pre-push uses the default `HEAD` comparison.

The survivor report must not contain hard-coded package names.

## 8. Testing strategy

Add deterministic tests for root security tooling. They should use temporary directories and fixtures and must not publish packages, modify the real user configuration directory, contact external services, or depend on a checked-out `sandbox/` implementation.

Required coverage includes:

- package discovery and package-name validation;
- extension entry and path containment validation;
- lifecycle-script rejection;
- required documentation validation;
- tarball forbidden-path detection;
- mutation glob matching across multiple package names;
- test, harness, generated-file, report, and sandbox exclusion;
- staged, unstaged, untracked, deleted, docs-only, and explicit-base-ref changes;
- missing CodeQL executable and CodeQL failure handling where practical;
- SARIF result checking for empty results, one finding, malformed JSON, and missing report files.

Root script tests must be included explicitly by Vitest. The existing package tests remain co-located with package source.

## 9. Documentation changes

Update repository documentation to describe:

- the new `security:*` and mutation commands;
- local CodeQL installation and usage;
- the local hook behavior when CodeQL is absent;
- the package publication policy;
- the changed-only mutation policy;
- the `sandbox/` exclusion;
- the need to configure required GitHub branch-protection checks.

Add or update package documentation for `mx-pi-context-stats`, including `CHANGELOG.md` and `SECURITY.md`, and include those files in its public artifact.

## 10. Non-goals

This work does not:

- convert `sandbox/` into an npm package or scan it as extension source;
- promise process-level isolation for ordinary extensions;
- replace human security review with automated checks;
- require a full mutation run on every PR;
- automatically remediate every existing dependency advisory;
- add unrelated runtime features to existing extensions;
- configure GitHub branch protection, repository secret scanning, or organization settings through code.

## 11. Acceptance criteria

The implementation is complete when:

1. every direct package under `packages/` is covered automatically without package-name-specific configuration;
2. `sandbox/` is excluded from quality/security package scope and mutation/CodeQL analysis;
3. local hooks run the agreed checks;
4. PR CI defines separate quality, package-security, mutation, CodeQL, and dependency-review jobs;
5. package tarballs are validated using npm’s dry-run output;
6. high/critical production dependency advisories fail the security job;
7. CodeQL uses the shared repository configuration and security-extended queries;
8. changed-source mutation uses the PR base SHA and an 80% break threshold;
9. new root tooling has deterministic tests;
10. the existing public package satisfies the documentation and publication policy;
11. `npm run check`, `npm test`, `npm run security`, local CodeQL, and changed-source mutation pass;
12. the final diff contains no secrets, generated reports, mutation databases, CodeQL databases, or unintended sandbox changes.

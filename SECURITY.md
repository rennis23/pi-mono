# Security policy

## Supported versions

Security fixes are applied to the current `master` branch and the latest published package versions where practical.

## Reporting a vulnerability

Please do not disclose an unpatched vulnerability in a public issue. Report it privately through the repository's GitHub security advisory mechanism or contact the repository maintainers through the private contact route listed in the repository settings.

Include:

- the affected package and version;
- a concise description of the boundary or capability involved;
- reproduction steps or a minimal proof of concept;
- the expected and observed behavior;
- any suggested mitigation.

We will acknowledge a report as soon as practical, investigate it, and coordinate disclosure after a fix or mitigation is available.

## Scope and limitations

Automated repository guardians cover package metadata and publication contents, dependency advisories, JavaScript/TypeScript CodeQL queries, and changed-source mutation testing. They do not prove that an extension is safe for every host configuration, provide process-level isolation for ordinary extensions, or replace human review of extension behavior and third-party providers.

The `sandbox/` directory contains separate smolvm runtime assets and is intentionally excluded from public package and extension analysis.

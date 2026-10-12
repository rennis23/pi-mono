---
name: chunk-auth
description: >-
  Handles `chunk` CLI authorization for CircleCI: OAuth/PKCE login, credential
  status checks, personal-token fallback, and the rule against exposing credential
  env vars. Use when the user says "log in to chunk", "chunk auth", "chunk auth
  status", "I need a CircleCI token", "401", "403", "token invalid", "CircleCI
  shows Not set", or when another skill (e.g. debug-ci-failures) finds auth missing
  or stale.
version: 1.0.0
allowed-tools:
  - Bash(chunk --version)
  - Bash(chunk auth status)
  - Bash(chunk auth login)
  - Bash(chunk auth login --no-browser)
  - Bash(chunk auth set circleci)
  - Bash(cat .chunk/config.json)
  - Bash(test -n*)
  - Read
---

# Chunk Auth

Single source of truth for `chunk` authorization. Other skills should call this
skill instead of repeating the login flow.

## Step 1 — Check the CLI and current state

Run these read-only probes first:

```bash
chunk --version 2>&1 || echo "CHUNK_NOT_INSTALLED"
chunk auth status 2>&1
cat .chunk/config.json 2>&1 || echo "{}"
```

If `chunk` is not on PATH, stop and tell the user to install it (e.g.
`brew install circleci/tools/chunk` on macOS) before continuing.

## Step 2 — Read the credential status

`chunk auth status` prints the state of each credential:

| Credential  | Required for                                |
|-------------|---------------------------------------------|
| CircleCI    | Every `chunk` command (required)            |
| GitHub      | Validate commands that fetch PRs/issues     |
| Anthropic   | Validate commands that invoke Claude        |

- **CircleCI "Not set"** → run the login in Step 3, then re-run `chunk auth status`
  and confirm "Configured" before continuing anything else.
- **GitHub / Anthropic missing** → report it, but do not block if the commands the
  user wants to run don't need them.
- **CircleCI source reported as `Environment`** → do **not** log in. `CIRCLE_TOKEN`
  is already set and wins over the keychain, so a login would store a token that
  never gets used. Treat it as configured.

## Step 3 — Log in with OAuth

OAuth is the default. The user opens a URL, the code comes back over PKCE, and the
token lands in the system keychain — no token pasting, nothing written to disk in
plaintext.

```bash
chunk auth login
```

- Run with a **Bash timeout of 300000ms**: it blocks until the callback lands
  (5 minute limit).
- No browser opens when an agent runs it — stdin is not a terminal, so the command
  prints the authorize URL and waits. **Relay that URL and ask the user to open it.**
  Never open a browser on their behalf.
- The callback listens on `127.0.0.1` on **this** machine, so the URL only works from
  a browser on the same host. `--no-browser` forces the same print-and-wait behaviour
  when a terminal is present.

## Step 4 — Token fallback

Use `chunk auth set circleci` (paste a personal API token) only when OAuth is
unavailable or the user explicitly asks for token auth. Both paths land in the
keychain; `--insecure-storage` writes to `~/.config/chunk/config.json` instead and
should be avoided unless the user asks for it.

## Rules

- **Never run `echo $CIRCLE_TOKEN`, `env`, `printenv`, or any command that exposes
  credential env vars.** `chunk auth status` masks tokens — it is the only safe way to
  check credentials.
- Check with `test -n "${CIRCLE_TOKEN:-}"` or `test -n "${CIRCLECI_ORG_ID:-}"` when a
  skill needs to know whether a variable is set — never print its value.
- Do not hand-edit `.chunk/config.json`. Use `chunk config set` for the keys a skill is
  allowed to write.

## Troubleshooting

- **401 / 403, "token invalid"** → run `chunk auth status`; if the CircleCI token is
  stale or missing, re-run `chunk auth login` and follow the printed remediation.
- **`Could not select an organization` / `no interactive terminal`** → auth is fine,
  `orgID` is missing. Check `.chunk/config.json` and `test -n "${CIRCLECI_ORG_ID:-}"`;
  if both are unset, ask the user for the org UUID (CircleCI → Organization Settings,
  the UUID at the top of the page) and run `chunk config set orgID <id>`.
- **Keychain unavailable** → fall back to `chunk auth set circleci`.

## Used by

- `debug-ci-failures` — run this skill first when the CircleCI MCP server or `chunk`
  reports missing/unauthorized credentials.

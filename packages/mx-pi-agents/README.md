# @rennis23/mx-pi-agents

Switch the main [pi.dev](https://pi.dev) session between named agent definitions.

Each definition is a markdown file with frontmatter plus a prompt body. A switch
can replace or append to the system prompt and preset the session's tools,
model, thinking level, skills and project context files. `tools` is either an
exact preset or, with `+name`/`-name` entries, a delta on top of the selection the
session already has. Definitions are pinned at session start and re-hashed every
turn, project definitions are gated behind approval, and a preset that does not
fully resolve refuses the whole switch.

> **Scope.** This package is the trimmed, persona-only extraction of
> `mx-pi-agents`. It does **not** run subagents: there is no `mx_pi_agent` tool,
> no `#[…]` pipeline, no budgets, no sandbox, no path scope, no telemetry and no
> progress widget. A persona changes the main session; it never spawns a child.

See [SECURITY.md](./SECURITY.md) for the threat model and, importantly, for what
is *not* enforced.

## Install

```bash
pi install npm:@rennis23/mx-pi-agents
```

Or from a checkout:

```bash
pi -e ./packages/mx-pi-agents
```

## Usage

Switch the main session from the interactive prompt with a `#` directive:

```text
#socrates                         switch, then wait
#socrates question this plan      switch, then send the task under the new persona
#none                             reset to plain pi (takes no task)
```

A definition's `system_prompt` field decides the prompt effect:

| `system_prompt` | Default | Prompt effect | Preset |
| --- | --- | --- | --- |
| `replace` | — | body replaces the default prompt prefix (pi's rules, docs, project context and cwd sections stay) | `tools`, `model`, `thinking`, `skills`, `context_files` |
| `append` | yes | body appends to the system prompt | same |

Absent `system_prompt` means `append`. Any other value drops the definition with
a diagnostic. The reserved name `none` can never be a definition name.

Typing `#` at the start of an empty input opens autocomplete listing every
pinned agent with its mode badge, description and source, plus a built-in
`pi.dev [base]` row that inserts `#none`. Input that starts with `#` but does not
parse is reported in the UI and **not** forwarded to the model. A bracketed
`#[…]` input is rejected with a message, because delegation is not part of this
package.

While a switch is active:

- the footer shows `replace:<name>` or `append:<name>` (`ctx.ui.setStatus` key
  `mx-pi-agents`);
- `tools`, `model` and `thinking` are applied as a preset and restored by
  `#none`; a `tools` delta applies on top of the selection active when the switch
  runs, and `#none` still restores the pristine session baseline;
- `skills` and `context_files` narrow what the resource loader puts into the
  prompt: absent means every loaded entry, `[]` means none, a list is an
  allow-list (unknown entries match nothing);
- `before_agent_start` re-verifies the pinned hash on every turn. If the file
  was removed or edited, the switch is deactivated with a one-time warning and
  the base prompt is used.

The preset is applied fail-closed: if any declared tool does not resolve in the
main session, or a declared model is unavailable, the whole switch is refused
and nothing changes.

A switch is scoped to the session, persisted as a non-context custom entry
(`mx-pi-agents.switch`) and re-applied on resume. The prompt is always
re-derived; the preset is only re-applied when the runtime still reflects the
switch.

## Writing an agent

Create `<agentDir>/agents/my-agent.md` (global, trusted) or
`<cwd>/.pi/agents/my-agent.md` (project, gated behind approval):

```markdown
---
name: reviewer
description: Review a diff for correctness and security
system_prompt: replace
tools: [read, grep]
model: anthropic/claude-sonnet-4-5
thinking: medium
---

You are a meticulous code reviewer. Report findings by severity and cite
file:line evidence.
```

### Tool deltas

Plain tool names replace the selection. `+name` adds one tool and `-name` removes
one, applied in list order, so a definition can extend the session it is switched
into instead of dictating it:

```markdown
---
name: reviewer
description: Review a diff for correctness and security
system_prompt: replace
tools: [+codemode, -write]
---

You are a meticulous code reviewer. Report findings by severity and cite
file:line evidence.
```

The rule matches pi's `defaultTools` entries:

- a list of only `+name`/`-name` applies on top of the selection active when the
  switch runs, so `read`, `bash`, `edit` and `write` survive;
- a list with a plain name forms the selection first, then modifiers apply in
  order, so `[-bash, read]` resolves to `read` and the `-bash` matches nothing;
- adding a tool the session already has, or removing one it does not have, is a
  no-op;
- `#none` still restores the pristine session baseline, and `/mx-pi-agents status`
  shows the declared entries next to the resolved selection.

A declared name that does not resolve in the main session still refuses the whole
switch, so a typo in a delta never silently does nothing.

### Frontmatter reference

| Field | Required | Values | Notes |
| --- | --- | --- | --- |
| `name` | yes | `[a-z0-9][a-z0-9_-]{0,63}` | Identity. `none` is reserved. The definition file MUST be named `<name>.md` |
| `description` | yes | ≤ 512 chars | Shown in the roster and autocomplete |
| `system_prompt` | no | `replace`, `append` | Absent means `append`. Anything else drops the definition |
| `tools` | no | tool names, `+name`, `-name` | Absent leaves the active tools untouched; `[]` means no tools; plain names are an exact preset; a list of only `+name`/`-name` changes the inherited selection instead of replacing it |
| `skills` | no | list of skill names | Allow-list while active. Absent = all loaded skills; `[]` = none |
| `context_files` | no | list of paths | Allow-list by absolute path, cwd-relative path or basename |
| `model` | no | `provider/model-id` or model id | Must resolve with configured credentials |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Applied after the switch |

**Unknown fields drop the definition.** So does any parse error, a missing body,
or an invalid name. There is no partial acceptance.

## Discovery and trust

| Source | Path | Trust |
| --- | --- | --- |
| bundled | package `agents/` | trusted |
| global | `<agentDir>/agents/` | trusted |
| config | each `agentPaths` entry | **gated** |
| project | `<cwd>/.pi/agents/` | **gated** |

A gated definition that shadows a trusted name is dropped with a diagnostic — a
repository cannot override a globally installed agent. Gated definitions need
approval, which pins the file's SHA-256; any edit invalidates the approval.
Headless sessions refuse gated definitions unless a matching approval already
exists.

```bash
/mx-pi-agents list      # roster with mode, source, trust and pinned hash
/mx-pi-agents approve   # open a dialog per gated definition and pin its hash
/mx-pi-agents status    # config path, roster counts, gated count, active and default persona, declared tool entries
/mx-pi-agents refresh   # re-pin the registry from disk
```

## Configuration

Local state lives in `<agentDir>/extensions/mx-pi-agents.json`:

```json
{
  "version": 1,
  "agentPaths": ["~/team-agents", "./shared/agents"],
  "approvals": {}
}
```

`agentPaths` entries are resolved against the config file's directory. Approvals
are keyed by real directory and file name and store the approved SHA-256. A
corrupt config file falls back to defaults with a diagnostic; it never blocks a
session.

### Settings

`defaultPersona` is registered with `@rennis23/mx-pi-settings`. When set, it is
applied at session start (only when no switch was rehydrated from the branch). An
empty value means plain pi; an unknown name notifies and stays plain; a gated
name goes through the approval flow.

```bash
pi --mx-pi-settings-set 'mx-pi-agents.defaultPersona=socrates'
```

`agentPaths` intentionally stays in the local JSON (there is no settings field
for a path list); only `defaultPersona` is exposed to the hub.

### Flags

| Flag | Effect |
| --- | --- |
| `--mx-pi-agents-list` | Print the roster on startup |
| `--mx-pi-agents-disable` | Disable `#` directives for this run |

## Bundled agents

| Agent | System prompt | Tools | Purpose |
| --- | --- | --- | --- |
| `socrates` | `replace` | none | Socratic questioning of a problem with a chosen number of questions; proposes no answers |

## Development

```bash
npm test --workspace @rennis23/mx-pi-agents
npm run check
```

`src/` is pure logic with no pi types (except the minimal `ThemeLike` surface in
`render.ts`), so every module is unit-testable without loading pi or a TUI.
`test/harness.ts` is a fake pi API used to drive `index.ts` end to end.

## License

MIT

# Definition of Done (DoD) for AI Agents

A task is considered **done** when an AI agent has met all the following criteria:

## 1. Code Quality Gates ✅

- [ ] `npm run check` passes with zero errors (Biome + TypeScript)
- [ ] `npm test` passes with all tests green
- [ ] No linting warnings or errors remain
- [ ] Code follows project conventions (see AGENTS.md)
- [ ] No `TODO`, `FIXME`, or placeholder comments left without implementation

## 2. Functional Requirements ✅

- [ ] All acceptance criteria from the original task are met
- [ ] Edge cases and error conditions are handled
- [ ] Changes work in the intended environment (Node.js 22+)
- [ ] No regressions introduced in existing functionality

## 3. Testing ✅

- [ ] New functionality has co-located tests (`*.test.ts` next to source)
- [ ] Tests cover happy path, edge cases, and error scenarios
- [ ] Test coverage is maintained or improved
- [ ] Tests are deterministic (no flaky tests)
- [ ] Mocks and stubs are properly cleaned up (Vitest handles this automatically)

## 4. Documentation ✅

- [ ] Public APIs have clear JSDoc comments where non-obvious
- [ ] README updated if user-facing behavior changed
- [ ] AGENTS.md updated if project conventions changed
- [ ] Complex logic has inline comments explaining "why", not "what"

## 5. Self-Verification ✅

- [ ] Agent re-read its changes before declaring done
- [ ] Agent ran all verification commands (`check`, `test`) and confirmed output
- [ ] Agent reviewed diff to ensure no unintended changes
- [ ] Agent confirmed changes align with original request

## 6. Communication ✅

- [ ] Clear summary of what was done
- [ ] List of files created or modified
- [ ] Any assumptions or decisions explained
- [ ] Known limitations or future work noted (if any)
- [ ] Commands to verify the work (e.g., "run `npm test` to see the new tests pass")

## 7. Git Hygiene ✅

- [ ] No secrets, credentials, or sensitive data in code
- [ ] No commented-out code blocks
- [ ] No unnecessary debug logs or console statements
- [ ] `.gitignore` respected (no `node_modules`, `dist`, `.pi` committed)
- [ ] Changes are atomic (one logical change per task)

---

## Anti-Patterns (DoD NOT Met) ❌

The following indicate the task is **not done**:

- ❌ "I've written the code but haven't run the tests yet"
- ❌ "The tests fail but that's expected" (without explanation)
- ❌ "You should run `npm run check` to see if it works"
- ❌ Leaving `TODO #blueblee` markers without executing them
- ❌ Creating files outside the project structure without justification
- ❌ Modifying files not related to the task
- ❌ Adding dependencies without explanation
- ❌ Claiming completion without verification

---

## Example: DoD Checklist for "Add a new extension"

```
✅ Created packages/pi-<name>/ with proper structure
✅ Added package.json with @rennis23/pi-<name> name and pi.extensions field
✅ Implemented extension in index.ts with proper TypeScript types
✅ Added hello.test.ts with comprehensive tests
✅ Ran npm run check - passed
✅ Ran npm test - passed
✅ Updated root README.md if needed
✅ Provided summary: "Created pi-<name> extension that does X. Files: packages/pi-<name>/index.ts, packages/pi-<name>/hello.test.ts, packages/pi-<name>/package.json. Verify with: npm test"
```

---

## Agent Self-Check Template

Before declaring a task done, the agent should internally verify:

```
1. Did I run `npm run check`? → [Show output]
2. Did I run `npm test`? → [Show output]
3. Did I re-read my changes? → [Confirm yes]
4. Are all acceptance criteria met? → [List each one]
5. Did I avoid scope creep? → [Confirm only requested changes]
6. Is my summary clear and actionable? → [Review summary]
```

---

**Note:** This DoD applies to all AI agent work in pi-mono. If any criterion cannot be met, the agent must explicitly state which one and explain why before claiming completion.

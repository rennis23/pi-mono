## 2024-05-23 - XSS in TUI Notifications
**Vulnerability:** Untrusted user input from CLI arguments (`cmd` and `arg` in `/mx-pi-settings`) was passed directly to `ctx.ui.notify` without HTML escaping, creating a Cross-Site Scripting (XSS) vulnerability.
**Learning:** In the `pi-coding-agent` ecosystem, TUI notifications support HTML rendering. Any unsanitized input passed to these functions can execute arbitrary code or corrupt the UI.
**Prevention:** Always use an `escapeHtml` utility to sanitize user inputs before passing them to `ctx.ui.notify` or any UI rendering functions. Handle edge cases like `null` or `undefined` by coercing to strings to avoid runtime errors.

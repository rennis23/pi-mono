## 2024-05-18 - [XSS] Fix Cross-Site Scripting (XSS) in UI notification parameters
**Vulnerability:** User inputs such as `cmd`, `arg` inside `/mx-pi-settings` command, and potentially other parameters in settings, are directly passed to `ctx.ui.notify` without HTML escaping, which could allow XSS attacks.
**Learning:** `ctx.ui.notify` likely treats input as HTML (or doesn't sanitize properly in the host context) according to memory instructions.
**Prevention:** Implement and use an `escapeHtml` function before passing user input to `ctx.ui.notify`.

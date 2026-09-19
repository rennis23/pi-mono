## 2024-09-19 - Fix XSS Vulnerability in UI Notifications
**Vulnerability:** Untrusted user input from extension commands was being directly interpolated into `ctx.ui.notify` calls, exposing a Cross-Site Scripting (XSS) vulnerability.
**Learning:** All inputs from the CLI command context (like `args` and parsed `cmd`/`arg` values) are untrusted and must be sanitized. Directly passing them into UI rendering functions without escaping enables malicious payload execution.
**Prevention:** Always HTML-escape untrusted user inputs or variable error messages using a robust utility (like `escapeHtml` that properly handles `null`/`undefined`) before passing them to UI APIs like `ctx.ui.notify`.

## 2024-09-06 - XSS in pi-hello UI notify
**Vulnerability:** Unsanitized user input from extension commands was directly passed to `ctx.ui.notify`, allowing potential Cross-Site Scripting (XSS) if malicious HTML/JS payloads were provided as arguments.
**Learning:** Any input passed to UI functions like `ctx.ui.notify` in pi-coding-agent extensions must be treated as untrusted and HTML-escaped.
**Prevention:** Always use an HTML escaping function (e.g., converting `<`, `>`, `&`, `"`, `'` to their respective HTML entities) on user input before passing it to UI rendering functions.
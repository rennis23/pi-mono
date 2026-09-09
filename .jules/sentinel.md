## 2024-05-14 - Fix XSS in mx-pi-context-stats extension UI notifications
**Vulnerability:** Unsanitized user inputs (e.g. `arg`, `cmd`) were passed directly to `ctx.ui.notify` in the mx-pi-context-stats extension settings command handler. This could allow execution of arbitrary code via XSS since these parameters come from user commands.
**Learning:** `ctx.ui.notify` in the pi-coding-agent extension API renders HTML, and therefore any interpolated user strings must be safely escaped.
**Prevention:** Add and use an `escapeHtml` utility function whenever rendering untrusted variables (like raw command arguments) into UI notifications.

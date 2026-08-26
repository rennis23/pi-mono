## 2023-10-27 - [XSS in Notification]
**Vulnerability:** User input passed to `ctx.ui.notify` without sanitization.
**Learning:** `ctx.ui.notify` likely renders HTML, and passing raw user input creates an XSS vector in the agent UI.
**Prevention:** Always HTML-escape user input before passing it to `ctx.ui.notify`.

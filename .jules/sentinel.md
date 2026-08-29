## 2024-03-21 - [High] Cross-Site Scripting (XSS) in UI Notifications
**Vulnerability:** User input passed to `ctx.ui.notify` without HTML escaping in `pi-hello` extension.
**Learning:** `pi.dev` extension UI components might render HTML content. Any user input passed to UI functions like `ctx.ui.notify` must be properly escaped to prevent XSS attacks within the agent environment.
**Prevention:** Always HTML-escape untrusted input before passing it to `ctx.ui.*` rendering functions. Use a robust HTML escaping function or library.
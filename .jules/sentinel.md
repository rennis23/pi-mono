## 2024-05-24 - Cross-Site Scripting (XSS) in UI notifications
**Vulnerability:** User inputs are rendered directly in the UI notifications via `ctx.ui.notify` without escaping HTML.
**Learning:** `ctx.ui.notify` likely displays string inputs as HTML in the UI; passing raw unescaped values such as user-provided arguments opens the possibility of Cross-Site Scripting (XSS).
**Prevention:** Sanitize user input passed to `ctx.ui.notify` (and other `ctx.ui` methods) by escaping characters like `<` and `>` into `&lt;` and `&gt;`.

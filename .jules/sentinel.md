## 2024-08-28 - XSS Vulnerability in UI Notifications
**Vulnerability:** The `target` parameter in the `pi-hello` extension was passed directly to `ctx.ui.notify` without HTML escaping, which could lead to Cross-Site Scripting (XSS) if malicious input was provided.
**Learning:** User input from extension arguments passed to UI functions like `ctx.ui.notify` must be HTML-escaped to prevent XSS vulnerabilities.
**Prevention:** Use an HTML escape function or rely on a framework's built-in escaping mechanisms for all user input that ends up in UI components or notifications.

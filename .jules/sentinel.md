## 2024-08-13 - Prevent XSS in Extension API Notifications
**Vulnerability:** User input (`args`) in `helloExtension` was passed directly to `ctx.ui.notify` without HTML escaping, creating a Cross-Site Scripting (XSS) vulnerability if malicious input was injected.
**Learning:** Functions that render output to the UI (like `ctx.ui.notify` in `@earendil-works/pi-coding-agent`) require manual HTML escaping for user inputs to prevent XSS. This is a critical pattern when developing extensions.
**Prevention:** Always sanitize and escape user input before passing it to any UI-rendering functions provided by the Extension API.

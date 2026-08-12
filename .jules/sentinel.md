## 2024-05-18 - XSS in UI Notification
**Vulnerability:** User input passed directly to `ctx.ui.notify` without escaping in `packages/pi-hello/index.ts`.
**Learning:** Even simple extension arguments are an XSS vector if passed directly into UI components like notifications.
**Prevention:** Always use an HTML escaping function on dynamic data (e.g. user arguments) before injecting into UI surfaces that render HTML or are otherwise susceptible to XSS.

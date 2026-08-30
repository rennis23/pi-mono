## 2024-08-30 - [Fix XSS vulnerability in UI notification]
**Vulnerability:** The pi-hello extension passed unsanitized user arguments directly into the `ctx.ui.notify` UI function.
**Learning:** Any unsanitized user input passed from the extension to UI commands (like `notify`) could be executed or incorrectly rendered, potentially leading to XSS if the UI platform dynamically evaluates HTML.
**Prevention:** All user input, especially from command arguments, must be HTML-escaped before passing them to UI functions.

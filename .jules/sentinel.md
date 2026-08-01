## 2025-01-01 - Path Traversal in Shell Scripts

**Vulnerability:** The sandbox launch script (`sandbox/scripts/run-agent.sh`) was vulnerable to path traversal. The `--allowlist` parameter was concatenated directly into a file path (`allowlists/${ALLOWLIST}.txt`) and the `--config` guest path name was concatenated into the volume mount path without sanitization. An attacker could use `../` to access unintended files on the host or mount arbitrary directories into the guest VM.

**Learning:** Shell scripts taking user input for file paths or volume mounts are particularly susceptible to path traversal. Simply appending an input string to a directory path is unsafe without input validation.

**Prevention:** Always validate shell script arguments that are used as paths. Check for directory separators (`/`) or parent directory references (`..`) and reject the input if they are present.

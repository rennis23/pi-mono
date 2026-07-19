#!/usr/bin/env bash
# Install (or uninstall) smolvm and verify it works.
set -euo pipefail

if [ "${1:-}" = "--uninstall" ]; then
	curl -sSL https://smolmachines.com/install.sh | bash -s -- --uninstall
	exit 0
fi

if command -v smolvm >/dev/null 2>&1; then
	echo "smolvm already installed: $(command -v smolvm)"
else
	curl -sSL https://smolmachines.com/install.sh | bash
fi

smolvm --version
echo "smoke test (ephemeral VM, no network):"
smolvm machine run --image alpine -- uname -a
echo "install-smolvm: OK"

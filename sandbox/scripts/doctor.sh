#!/usr/bin/env bash
# Preflight checks for the pi-agent smolvm sandbox.
set -euo pipefail

fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
warn() { printf '  warn  %s\n' "$1"; }

echo "== platform =="
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
	ok "macOS arm64 ($(sw_vers -productVersion))"
else
	bad "requires macOS on Apple Silicon (got $(uname -s) $(uname -m))"
fi

echo "== smolvm =="
if command -v smolvm >/dev/null 2>&1; then
	ok "smolvm $(smolvm --version 2>/dev/null || echo '(version unknown)') at $(command -v smolvm)"
else
	bad "smolvm not found — run sandbox/scripts/install-smolvm.sh"
fi

echo "== image builder =="
if command -v podman >/dev/null 2>&1; then
	ok "podman at $(command -v podman)"
	if podman info >/dev/null 2>&1; then
		ok "podman machine running"
	else
		warn "podman installed but machine not running — 'podman machine start'"
	fi
elif command -v docker >/dev/null 2>&1; then
	ok "docker at $(command -v docker)"
else
	bad "neither podman nor docker found — needed to build the agent image"
fi

echo "== ssh agent =="
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
	ok "SSH_AUTH_SOCK set"
	if ssh-add -l >/dev/null 2>&1; then
		ok "agent has identities"
	else
		warn "agent has no identities — git over SSH in the VM will fail (ssh-add your key)"
	fi
else
	bad "SSH_AUTH_SOCK not set — --ssh-agent forwarding will fail"
fi

echo "== secrets =="
found_key=0
for key in ANTHROPIC_API_KEY OPENAI_API_KEY OPENCODE_API_KEY AWS_BEARER_TOKEN_BEDROCK; do
	if [ -n "${!key:-}" ]; then
		ok "$key set"
		found_key=1
		case "${!key}" in
			*[[:space:]]*|\"*|\'*)
				warn "$key contains whitespace or quotes — this usually breaks API auth (401)" ;;
		esac
	fi
done
if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
	ok "AWS access key pair set (Bedrock)"
	found_key=1
fi
[ "$found_key" -eq 1 ] || warn "no LLM credentials in env (ANTHROPIC/OPENAI/OPENCODE key, AWS pair, or AWS_BEARER_TOKEN_BEDROCK) — pi will have no provider"

echo
if [ "$fail" -ne 0 ]; then
	echo "doctor: FAILURES above must be fixed before running the sandbox"
	exit 1
fi
echo "doctor: all required checks passed"

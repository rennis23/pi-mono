#!/usr/bin/env bash
# Preflight checks for the pi-agent lima sandbox.
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

MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$MACOS_MAJOR" -ge 13 ] 2>/dev/null; then
	ok "macOS >= 13 (vz + virtiofs)"
else
	bad "macOS >= 13 required for vmType vz with virtiofs mounts (got $(sw_vers -productVersion))"
fi

echo "== lima =="
if command -v limactl >/dev/null 2>&1; then
	LIMA_VERSION="$(limactl --version 2>/dev/null | awk '{print $3}')"
	LIMA_MAJOR="${LIMA_VERSION%%.*}"
	if [ "${LIMA_MAJOR:-0}" -ge 2 ] 2>/dev/null; then
		ok "limactl $LIMA_VERSION at $(command -v limactl)"
	else
		bad "limactl >= 2.0 required (shellenv/param support), got '$LIMA_VERSION' — brew upgrade lima"
	fi
else
	bad "limactl not found — brew install lima"
fi

if limactl template yq template:_images/alpine-3.23 '.images[].location' >/dev/null 2>&1; then
	ok "template:_images/alpine-3.23 resolvable"
else
	bad "template:_images/alpine-3.23 not resolvable — agent.lima.yaml bases on it (ships with lima)"
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
	bad "SSH_AUTH_SOCK not set — ssh agent forwarding will fail"
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

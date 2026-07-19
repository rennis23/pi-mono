#!/usr/bin/env bash
# Launch pi-coding-agent inside an isolated smolvm microVM.
#
# Usage:
#   run-agent.sh [options] [-- pi-args...]
#
# Options:
#   --workspace DIR     host dir mounted at /workspace (default: $PWD)
#   --allowlist NAME    egress preset from allowlists/NAME.txt (default: default;
#                       use "offline" for no network at all)
#   --persistent        use a named persistent machine (package installs survive)
#   --name NAME         machine name for --persistent (default: pi-agent)
#   --shell             drop into a VM shell instead of running pi
#   -h, --help          show this help
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOLFILE="${SANDBOX_DIR}/agent.smolfile"

WORKSPACE="$PWD"
ALLOWLIST="default"
PERSISTENT=0
NAME="pi-agent"
SHELL=0

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0; }

while [ $# -gt 0 ]; do
	case "$1" in
		--workspace)  WORKSPACE="$2"; shift 2 ;;
		--allowlist)  ALLOWLIST="$2"; shift 2 ;;
		--persistent) PERSISTENT=1; shift ;;
		--name)       NAME="$2"; shift 2 ;;
		--shell)      SHELL=1; shift ;;
		-h|--help)    usage ;;
		--)           shift; break ;;
		*)            break ;;
	esac
done

ALLOWLIST_FILE="${SANDBOX_DIR}/allowlists/${ALLOWLIST}.txt"
[ -f "$ALLOWLIST_FILE" ] || { echo "error: no allowlist '${ALLOWLIST}' (${ALLOWLIST_FILE})" >&2; exit 1; }
[ -f "${SANDBOX_DIR}/images/pi-agent.tar" ] || {
	echo "error: images/pi-agent.tar missing — run sandbox/scripts/build-image.sh first" >&2
	exit 1
}
[ -n "${SSH_AUTH_SOCK:-}" ] || { echo "error: SSH_AUTH_SOCK not set (needed for --ssh-agent)" >&2; exit 1; }

# Build egress flags from the allowlist (skip comments/blanks). Any non-empty
# list implies --net; the "offline" preset is empty → no network at all.
NET_ARGS=()
while IFS= read -r host; do
	case "$host" in ''|'#'*) continue ;; esac
	NET_ARGS+=(--allow-host "$host")
done < "$ALLOWLIST_FILE"
if [ "${#NET_ARGS[@]}" -eq 0 ] && [ "$ALLOWLIST" != "offline" ]; then
	echo "warn: allowlist '${ALLOWLIST}' is empty — VM will have no network" >&2
fi

# Forward LLM/git secrets only for keys actually set on the host — smolvm
# fails hard on a secret ref whose source env var is unset.
SECRET_ARGS=()
for key in ANTHROPIC_API_KEY OPENAI_API_KEY OPENCODE_API_KEY GH_TOKEN \
	AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_BEARER_TOKEN_BEDROCK; do
	if [ -n "${!key:-}" ]; then
		SECRET_ARGS+=(--secret-env "$key=$key")
	fi
done

# Non-secret passthrough config
ENV_ARGS=()
for key in AWS_REGION AWS_DEFAULT_REGION; do
	if [ -n "${!key:-}" ]; then
		ENV_ARGS+=(-e "$key=${!key}")
	fi
done

CMD=(pi)
[ "$SHELL" -eq 1 ] && CMD=(bash)
# Append any extra args after -- to the guest command
[ $# -gt 0 ] && CMD+=("$@")

cd "$SANDBOX_DIR"  # Smolfile-relative image path

if [ "$PERSISTENT" -eq 1 ]; then
	if ! smolvm machine status --name "$NAME" >/dev/null 2>&1; then
		echo "== creating persistent machine '${NAME}' =="
		smolvm machine create --name "$NAME" -s "$SMOLFILE" \
			-v "$WORKSPACE:/workspace" "${NET_ARGS[@]}" "${SECRET_ARGS[@]}" "${ENV_ARGS[@]}"
	fi
	smolvm machine start --name "$NAME"
	exec smolvm machine exec --name "$NAME" -it -- "${CMD[@]}"
else
	exec smolvm machine run -s "$SMOLFILE" -it \
		-v "$WORKSPACE:/workspace" "${NET_ARGS[@]}" "${SECRET_ARGS[@]}" "${ENV_ARGS[@]}" \
		-- "${CMD[@]}"
fi

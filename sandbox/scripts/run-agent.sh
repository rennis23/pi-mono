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
#   --skill PATH        mount host skill file or skills directory read-only and load it (repeatable)
#   --extension PATH    mount host extension file/dir read-only and load it (repeatable)
#   --no-global-skills  skip the always-on sandbox/skills mount
#   --no-global-extensions
#                       skip the always-on sandbox/extensions mount
#   -h, --help          show this help
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOLFILE="${SANDBOX_DIR}/agent.smolfile"

WORKSPACE="$PWD"
ALLOWLIST="default"
PERSISTENT=0
NAME="pi-agent"
SHELL=0
GLOBAL_SKILLS=1
GLOBAL_EXTS=1
SKILL_PATHS=()
EXT_PATHS=()

usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0; }

while [ $# -gt 0 ]; do
	case "$1" in
		--workspace)  WORKSPACE="$2"; shift 2 ;;
		--allowlist)  ALLOWLIST="$2"; shift 2 ;;
		--persistent) PERSISTENT=1; shift ;;
		--name)       NAME="$2"; shift 2 ;;
		--shell)      SHELL=1; shift ;;
		--skill)      SKILL_PATHS+=("$2"); shift 2 ;;
		--extension)  EXT_PATHS+=("$2"); shift 2 ;;
		--no-global-skills)     GLOBAL_SKILLS=0; shift ;;
		--no-global-extensions) GLOBAL_EXTS=0; shift ;;
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

# Fully offline: tell pi to skip all model-catalog network access (avoids
# "Could not refresh N model catalogs" warnings in /model)
if [ "${#NET_ARGS[@]}" -eq 0 ]; then
	ENV_ARGS+=(-e PI_OFFLINE=1)
fi

# Volumes: workspace plus the always-on curated skills/extensions/settings.
# NOTE: nothing is mounted under /home/agent — smolvm creates mount-point
# parents as root (root:agent, group not writable), which would make
# ~/.pi/agent unwritable for the agent user (sessions, auth.json, ...).
# Instead the curated dirs are mounted under /opt and GUEST_INIT (prepended
# to CMD below) symlinks them into the agent-owned pi home.
VOL_ARGS=(-v "$WORKSPACE:/workspace")
GUEST_INIT_PARTS=()
if [ "$GLOBAL_SKILLS" -eq 1 ] && [ -d "${SANDBOX_DIR}/skills" ]; then
	VOL_ARGS+=(-v "${SANDBOX_DIR}/skills:/opt/pi-skills:ro")
	GUEST_INIT_PARTS+=('ln -sfn /opt/pi-skills /home/agent/.pi/agent/skills')
fi
if [ "$GLOBAL_EXTS" -eq 1 ] && [ -d "${SANDBOX_DIR}/extensions" ]; then
	VOL_ARGS+=(-v "${SANDBOX_DIR}/extensions:/opt/pi-extensions:ro")
	GUEST_INIT_PARTS+=('ln -sfn /opt/pi-extensions /home/agent/.pi/agent/extensions')
fi
# Guest pi settings (defaultProjectTrust: always — the VM is the trust boundary)
if [ -f "${SANDBOX_DIR}/pi-global/settings.json" ]; then
	VOL_ARGS+=(-v "${SANDBOX_DIR}/pi-global:/opt/pi-global:ro")
	GUEST_INIT_PARTS+=('ln -sfn /opt/pi-global/settings.json /home/agent/.pi/agent/settings.json')
fi
GUEST_INIT=""
if [ ${#GUEST_INIT_PARTS[@]} -gt 0 ]; then
	GUEST_INIT='mkdir -p /home/agent/.pi/agent'
	for part in "${GUEST_INIT_PARTS[@]}"; do
		GUEST_INIT+="; $part"
	done
fi

# Ad-hoc skills/extensions: directories are mounted read-only under /opt/adhoc
# (live view of the host) and passed to pi via --skill / -e. virtiofs cannot
# mount single files, so those are first staged (copied) into a temp dir —
# host edits to single files during a run are NOT reflected in the guest.
PI_EXTRA_ARGS=()
STAGING_DIRS=()
cleanup() { [ ${#STAGING_DIRS[@]} -eq 0 ] || rm -rf "${STAGING_DIRS[@]}"; }
trap cleanup EXIT
STAGED=0
for p in ${SKILL_PATHS[@]+"${SKILL_PATHS[@]}"}; do
	p="$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
	[ -e "$p" ] || { echo "error: skill path not found: $p" >&2; exit 1; }
	if [ -d "$p" ]; then
		dest="/opt/adhoc/skills/$(basename "$p")"
		VOL_ARGS+=(-v "$p:$dest:ro")
	else
		STAGED=$((STAGED+1))
		stage="$(mktemp -d "${TMPDIR:-/tmp}/pi-sandbox.XXXXXX")"
		STAGING_DIRS+=("$stage")
		cp "$p" "$stage/"
		VOL_ARGS+=(-v "$stage:/opt/adhoc/files/$STAGED:ro")
		dest="/opt/adhoc/files/$STAGED/$(basename "$p")"
	fi
	PI_EXTRA_ARGS+=(--skill "$dest")
done
for p in ${EXT_PATHS[@]+"${EXT_PATHS[@]}"}; do
	p="$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
	[ -e "$p" ] || { echo "error: extension path not found: $p" >&2; exit 1; }
	if [ -d "$p" ]; then
		dest="/opt/adhoc/extensions/$(basename "$p")"
		VOL_ARGS+=(-v "$p:$dest:ro")
	else
		STAGED=$((STAGED+1))
		stage="$(mktemp -d "${TMPDIR:-/tmp}/pi-sandbox.XXXXXX")"
		STAGING_DIRS+=("$stage")
		cp "$p" "$stage/"
		VOL_ARGS+=(-v "$stage:/opt/adhoc/files/$STAGED:ro")
		dest="/opt/adhoc/files/$STAGED/$(basename "$p")"
	fi
	PI_EXTRA_ARGS+=(-e "$dest")
done

if [ "$SHELL" -eq 1 ]; then
	CMD=(bash)
else
	CMD=(pi ${PI_EXTRA_ARGS[@]+"${PI_EXTRA_ARGS[@]}"})
fi
# Append any extra args after -- to the guest command
[ $# -gt 0 ] && CMD+=("$@")
# Link /opt mounts into the pi home before the real command starts
if [ -n "$GUEST_INIT" ]; then
	CMD=(bash -c "$GUEST_INIT; exec \"\$@\"" guest-init "${CMD[@]}")
fi

cd "$SANDBOX_DIR"  # Smolfile-relative image path

if [ "$PERSISTENT" -eq 1 ]; then
	if smolvm machine status --name "$NAME" >/dev/null 2>&1; then
		if [ ${#SKILL_PATHS[@]} -gt 0 ] || [ ${#EXT_PATHS[@]} -gt 0 ]; then
			echo "warn: machine '$NAME' already exists — ad-hoc --skill/--extension mounts only apply at create time;" >&2
			echo "      delete it first: smolvm machine delete --name $NAME" >&2
		fi
	else
		echo "== creating persistent machine '${NAME}' =="
		smolvm machine create --name "$NAME" -s "$SMOLFILE" \
			${VOL_ARGS[@]+"${VOL_ARGS[@]}"} \
			${NET_ARGS[@]+"${NET_ARGS[@]}"} ${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"} ${ENV_ARGS[@]+"${ENV_ARGS[@]}"}
	fi
	smolvm machine start --name "$NAME"
	exec smolvm machine exec --name "$NAME" -it -- "${CMD[@]}"
else
	exec smolvm machine run -s "$SMOLFILE" -it \
		${VOL_ARGS[@]+"${VOL_ARGS[@]}"} \
		${NET_ARGS[@]+"${NET_ARGS[@]}"} ${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"} ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
		-- "${CMD[@]}"
fi

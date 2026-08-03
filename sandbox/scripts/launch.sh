#!/usr/bin/env bash
# Launch pi-coding-agent inside a persistent lima VM (hardware-isolated on macOS).
#
# Usage:
#   launch.sh [options] [-- pi-args...]
#
# Options:
#   --workspace DIR     host dir mounted at /workspace (default: $PWD)
#   --allowlist NAME    egress preset; only "offline" is special (no network at
#                       all). Any other name warns and runs with full network —
#                       filtering is not yet implemented (see TODO.md)
#   --name NAME         lima instance name (default: pi-agent)
#   --fresh             stop/delete/recreate the instance for a clean slate
#   --shell             drop into a VM shell instead of running pi
#   --skill PATH        mount host skill file or skills directory read-only and load it (repeatable)
#   --extension PATH    mount host extension file/dir read-only and load it (repeatable)
#   --config PATH:NAME  mount host config directory read-write into guest ~/.pi/agent/NAME/ (repeatable)
#   --no-global-skills  skip the always-on sandbox/skills mount
#   --no-global-extensions
#                       skip the always-on sandbox/extensions mount
#   -h, --help          show this help
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${SANDBOX_DIR}/agent.lima.yaml"
LIMA_HOME_DIR="${LIMA_HOME:-$HOME/.lima}"

WORKSPACE="$PWD"
ALLOWLIST="default"
NAME="pi-agent"
FRESH=0
SHELL=0
GLOBAL_SKILLS=1
GLOBAL_EXTS=1
SKILL_PATHS=()
EXT_PATHS=()
CONFIG_PATHS=()

usage() { sed -n '2,21p' "${BASH_SOURCE[0]}" | sed -e 's/^# //' -e 's/^#//'; exit 0; }

while [ $# -gt 0 ]; do
	case "$1" in
		--workspace)  WORKSPACE="$2"; shift 2 ;;
		--allowlist)  ALLOWLIST="$2"; shift 2 ;;
		--name)       NAME="$2"; shift 2 ;;
		--fresh)      FRESH=1; shift ;;
		--shell)      SHELL=1; shift ;;
		--skill)      SKILL_PATHS+=("$2"); shift 2 ;;
		--extension)  EXT_PATHS+=("$2"); shift 2 ;;
		--config)     CONFIG_PATHS+=("$2"); shift 2 ;;
		--no-global-skills)     GLOBAL_SKILLS=0; shift ;;
		--no-global-extensions) GLOBAL_EXTS=0; shift ;;
		-h|--help)    usage ;;
		--)           shift; break ;;
		*)            break ;;
	esac
done

# ── Allowlist resolution ─────────────────────────────────────────────────────
# Only "offline" has an effect: it flips the instance's OFFLINE param (boot
# script applies nftables block-all egress) and tells pi to skip catalog
# network access. allowlists/*.txt are retained for the TODO option-C work but
# are not read here.
OFFLINE=0
if [ "$ALLOWLIST" = "offline" ]; then
	OFFLINE=1
	export PI_OFFLINE=1
else
	echo "warn: allowlist '${ALLOWLIST}': egress filtering is not implemented in the lima sandbox (see TODO.md) — continuing with full network access" >&2
	unset PI_OFFLINE  # an online sandbox must not claim offline to pi
fi

[ -n "${SSH_AUTH_SOCK:-}" ] || {
	echo "error: SSH_AUTH_SOCK not set (needed for ssh agent forwarding)" >&2
	exit 1
}

# ── Instance introspection helpers ────────────────────────────────────────────
instance_status() { # empty output = does not exist
	limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | awk -v n="$NAME" '$1 == n {print $2}'
}
instance_file() { printf '%s/%s/lima.yaml' "$LIMA_HOME_DIR" "$NAME"; }
instance_param() { # $1 = param key; strips quotes yq may add around bool-ish strings
	limactl template yq "$(instance_file)" ".param.$1" 2>/dev/null | tr -d '"' | head -1
}
instance_workspace() {
	limactl template yq "$(instance_file)" '.mounts[] | select(.mountPoint == "/workspace") | .location' 2>/dev/null | tr -d '"' | head -1
}

# lima names the guest user after the host user when it is a valid Linux user
# name, otherwise "lima" (mirrors lima's own default). The guest home is
# /home/<user>.guest — the documented ".linux" alias does not exist on Alpine.
GUEST_USER="$(id -un)"
printf '%s' "$GUEST_USER" | grep -Eq '^[a-z_][a-z0-9_-]*\$?$' || GUEST_USER="lima"
GUEST_HOME="/home/${GUEST_USER}.guest"

stop_instance() {
	[ "$(instance_status)" = "Running" ] || return 0
	limactl stop "$NAME"
}

# Start with one forced retry: vz occasionally fails to wire up host->guest
# forwarding on a cold start (hostagent waits forever on the guest SSH port).
start_instance() { # $* = extra limactl start flags
	if limactl start "$NAME" --timeout 10m "$@"; then
		return 0
	fi
	echo "warn: start failed — force-stopping and retrying once" >&2
	limactl stop --force "$NAME" 2>/dev/null || true
	limactl start "$NAME" --timeout 10m "$@" || {
		echo "error: instance '${NAME}' failed to start — see ${LIMA_HOME_DIR}/${NAME}/ha.stderr.log" >&2
		exit 1
	}
}

# ── --fresh: wipe and recreate ────────────────────────────────────────────────
STATUS="$(instance_status)"
if [ "$FRESH" -eq 1 ] && [ -n "$STATUS" ]; then
	echo "== --fresh: deleting instance '${NAME}' =="
	stop_instance
	limactl delete "$NAME"
	STATUS=""
fi

if [ -z "$STATUS" ]; then
	# ── Create: bake mounts into the instance (lima cannot hot-mount) ──────
	WORKSPACE_PHYS="$(cd "$WORKSPACE" && pwd -P)" || {
		echo "error: workspace not found: $WORKSPACE" >&2
		exit 1
	}

	# JSON-escape a host path for embedding in the --set yq expression.
	json_escape() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }
	MOUNTS=""
	add_mount() { # $1 = host location, $2 = guest mountPoint, $3 = writable (true|false)
		MOUNTS="${MOUNTS}{\"location\": \"$(json_escape "$1")\", \"mountPoint\": \"$2\", \"writable\": $3}, "
	}

	add_mount "$WORKSPACE_PHYS" /workspace true
	if [ "$GLOBAL_SKILLS" -eq 1 ] && [ -d "${SANDBOX_DIR}/skills" ]; then
		add_mount "${SANDBOX_DIR}/skills" /opt/pi-skills false
	fi
	if [ "$GLOBAL_EXTS" -eq 1 ] && [ -d "${SANDBOX_DIR}/extensions" ]; then
		add_mount "${SANDBOX_DIR}/extensions" /opt/pi-extensions false
	fi
	# Guest pi settings (defaultProjectTrust: always — the VM is the trust boundary)
	if [ -f "${SANDBOX_DIR}/pi-global/settings.json" ]; then
		add_mount "${SANDBOX_DIR}/pi-global" /opt/pi-global false
	fi

	# Ad-hoc skills/extensions: directories are mounted read-only under
	# /opt/adhoc (live view of the host) and passed to pi via --skill / -e.
	# virtiofs cannot mount single files, so those are staged (copied) into a
	# temp dir — host edits to single files during a run are NOT reflected.
	PI_EXTRA_ARGS=()
	STAGING_DIRS=()
	cleanup() { [ ${#STAGING_DIRS[@]} -eq 0 ] || rm -rf "${STAGING_DIRS[@]}"; }
	trap cleanup EXIT
	STAGED=0

	# $1 = host path, $2 = dest subdir (e.g. skills), $3 = pi flag (e.g. --skill)
	add_adhoc_mount() {
		local p="$1" dest
		p="$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")"
		[ -e "$p" ] || { echo "error: $2 path not found: $p" >&2; exit 1; }
		if [ -d "$p" ]; then
			dest="/opt/adhoc/$2/$(basename "$p")"
			add_mount "$p" "$dest" false
		else
			STAGED=$((STAGED+1))
			local stage="$(mktemp -d "${TMPDIR:-/tmp}/pi-sandbox.XXXXXX")"
			STAGING_DIRS+=("$stage")
			cp "$p" "$stage/"
			add_mount "$stage" "/opt/adhoc/files/$STAGED" false
			dest="/opt/adhoc/files/$STAGED/$(basename "$p")"
		fi
		PI_EXTRA_ARGS+=("$3" "$dest")
	}
	for p in ${SKILL_PATHS[@]+"${SKILL_PATHS[@]}"}; do add_adhoc_mount "$p" skills --skill; done
	for p in ${EXT_PATHS[@]+"${EXT_PATHS[@]}"}; do add_adhoc_mount "$p" extensions -e; done

	# Extension config directories (e.g. Langfuse credentials) are mounted
	# read-write into the guest pi home; the host dir remains the source of truth.
	for cfg in ${CONFIG_PATHS[@]+"${CONFIG_PATHS[@]}"}; do
		case "$cfg" in
			?*:?*) ;;
			*) echo "error: --config requires PATH:NAME format, got: $cfg" >&2; exit 1 ;;
		esac
		host_path="${cfg%:*}"
		cfg_name="${cfg##*:}"
		host_path="$(cd "$host_path" && pwd -P)" || {
			echo "error: --config path must be a directory: ${cfg%:*}" >&2
			exit 1
		}
		add_mount "$host_path" "${GUEST_HOME}/.pi/agent/${cfg_name}" true
	done

	echo "== creating instance '${NAME}' (first boot provisions packages, ~1-3 min) =="
	limactl create --name="$NAME" --tty=false \
		--set ".mounts = [${MOUNTS%, }]" \
		"$CONFIG"
	start_instance
else
	# ── Existing-instance guards ─────────────────────────────────────────────
	WORKSPACE_PHYS="$(cd "$WORKSPACE" && pwd -P)" || {
		echo "error: workspace not found: $WORKSPACE" >&2
		exit 1
	}
	EXISTING_WS="$(instance_workspace)"
	if [ -n "$EXISTING_WS" ] && [ "$EXISTING_WS" != "$WORKSPACE_PHYS" ]; then
		echo "error: instance '${NAME}' was created with workspace '${EXISTING_WS}', but '${WORKSPACE_PHYS}' was requested." >&2
		echo "       lima cannot hot-mount — use --fresh to recreate, --name for a separate instance," >&2
		echo "       or run from the original workspace." >&2
		exit 1
	fi
	if [ ${#SKILL_PATHS[@]} -gt 0 ] || [ ${#EXT_PATHS[@]} -gt 0 ] || [ ${#CONFIG_PATHS[@]} -gt 0 ] \
		|| [ "$GLOBAL_SKILLS" -eq 0 ] || [ "$GLOBAL_EXTS" -eq 0 ]; then
		echo "warn: instance '${NAME}' already exists — --skill/--extension/--config/--no-global-* mounts" >&2
		echo "      only apply at create time; use --fresh to recreate or --name for a separate instance" >&2
	fi
fi

# ── Offline state reconciliation ─────────────────────────────────────────────
# The OFFLINE param is rendered into the boot script at every start, so the
# requested state is applied by flipping the param with a restart. New
# instances are always created online (provisioning needs network) and flipped
# here afterwards.
DESIRED_OFFLINE="false"
[ "$OFFLINE" -eq 1 ] && DESIRED_OFFLINE="true"
if [ "$(instance_param OFFLINE)" != "$DESIRED_OFFLINE" ]; then
	stop_instance
	start_instance --set ".param.OFFLINE=\"${DESIRED_OFFLINE}\""
elif [ "$(instance_status)" != "Running" ]; then
	start_instance
fi

# ── Hand over to the guest ───────────────────────────────────────────────────
if [ "$SHELL" -eq 1 ]; then
	CMD=(bash)
else
	CMD=(pi ${PI_EXTRA_ARGS[@]+"${PI_EXTRA_ARGS[@]}"})
fi
# Append any extra args after -- to the guest command
[ $# -gt 0 ] && CMD+=("$@")

# Secrets flow from the host env via --preserve-env (lima's default blocklist
# does not cover *_API_KEY / AWS_* / GH_TOKEN; SSH_AUTH_SOCK is blocklisted but
# agent forwarding covers git). NOTE: all other non-blocklisted host env is
# forwarded too — wrap in `env -i` if a minimal environment is wanted.
exec limactl shell --preserve-env --workdir /workspace "$NAME" "${CMD[@]}"

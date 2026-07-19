#!/usr/bin/env bash
# Build the pi-agent guest image and export it as a local archive for smolvm.
# smolvm does not build images — it boots OCI archives produced by docker/podman.
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="pi-agent:latest"
OUT_TAR="${SANDBOX_DIR}/images/pi-agent.tar"
PLATFORM="linux/arm64"

if command -v podman >/dev/null 2>&1; then
	BUILDER=podman
elif command -v docker >/dev/null 2>&1; then
	BUILDER=docker
else
	echo "error: podman or docker required" >&2
	exit 1
fi

echo "== building ${IMAGE_NAME} (${PLATFORM}) with ${BUILDER} =="
"$BUILDER" build --platform "$PLATFORM" \
	-f "${SANDBOX_DIR}/images/Dockerfile.agent" \
	-t "$IMAGE_NAME" \
	"${SANDBOX_DIR}"

echo "== exporting to ${OUT_TAR} =="
"$BUILDER" save "$IMAGE_NAME" -o "$OUT_TAR"

echo "build-image: OK -> ${OUT_TAR}"
echo "boot it with: sandbox/scripts/run-agent.sh"

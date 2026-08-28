#!/usr/bin/env bash
# รัน Pi ใน isolated profile (docker | gondolin | openshell)
# ใช้: scripts/pi-isolated.sh docker [pi args...]
# mount เฉพาะ development root ปัจจุบัน (cwd) และ Pi extension/config แบบ read-only; ไม่ mount credential ใด ๆ
set -euo pipefail

MODE="${1:-docker}"
shift || true
WORKSPACE="$(pwd)"
PI_HOME="${HOME}/.pi/agent"
IMAGE="${AGENTS_ADAPTER_PI_IMAGE:-node:24-bookworm-slim}"

case "$MODE" in
  docker)
    command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 2; }
    exec docker run --rm -it \
      -v "${WORKSPACE}:/workspace" \
      -v "${PI_HOME}/extensions:/root/.pi/agent/extensions:ro" \
      -v "${PI_HOME}/settings.json:/root/.pi/agent/settings.json:ro" \
      -v "${PI_HOME}/AGENTS.md:/root/.pi/agent/AGENTS.md:ro" \
      -e "PI_PROVIDER_API_KEY=${PI_PROVIDER_API_KEY:-}" \
      -w /workspace \
      "$IMAGE" \
      sh -c "npm install -g @earendil-works/pi-coding-agent >/dev/null 2>&1 && pi $*"
    ;;
  gondolin)
    command -v gondolin >/dev/null 2>&1 || { echo "gondolin not found; use docker profile" >&2; exit 2; }
    exec gondolin run --mount "${WORKSPACE}:/workspace" --workdir /workspace -- pi "$@"
    ;;
  openshell)
    command -v openshell >/dev/null 2>&1 || { echo "openshell not found; use docker profile" >&2; exit 2; }
    exec openshell run --mount "${WORKSPACE}:/workspace" --workdir /workspace -- pi "$@"
    ;;
  *)
    echo "unknown isolation mode: $MODE (docker|gondolin|openshell)" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
# ติดตั้ง agents-adapter: ตรวจ Node, ติดตั้ง dependency, สร้าง config, plan แล้ว apply
# ใช้: scripts/install.sh [--target claude|codex|pi|all] [--yes]
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="all"
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node >= 24 is required" >&2; exit 2; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "node >= 24 is required (found $(node --version))" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || echo "warning: python3 not found; Codex hooks will not run" >&2

[ -d node_modules ] || npm ci --no-audit --no-fund

node src/cli.ts init
echo
echo "== plan (dry-run) =="
node src/cli.ts plan --target "$TARGET"
echo
if [ "$YES" -ne 1 ]; then
  read -r -p "apply these changes? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted; nothing changed"; exit 0 ;; esac
fi
node src/cli.ts apply --target "$TARGET"
echo
node src/cli.ts doctor || true
echo
echo "done. rollback with: scripts/rollback.sh"

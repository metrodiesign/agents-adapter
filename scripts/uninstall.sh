#!/usr/bin/env bash
# ถอน managed content ของ agents-adapter ออกจาก ~/.claude ~/.codex ~/.pi (มี backup ก่อนเสมอ)
# ใช้: scripts/uninstall.sh [--target claude|codex|pi|all]
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${2:-all}"
[ "${1:-}" = "--target" ] || TARGET="all"
node src/cli.ts plan --target "$TARGET" >/dev/null
node src/cli.ts uninstall --target "$TARGET"

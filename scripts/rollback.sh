#!/usr/bin/env bash
# คืนไฟล์ทั้งหมดจาก backup ล่าสุด (หรือ --backup <id>) แบบ transaction
# ใช้: scripts/rollback.sh [--backup 20260101T000000Z] [--check]
set -euo pipefail
cd "$(dirname "$0")/.."
exec node src/cli.ts rollback "$@"

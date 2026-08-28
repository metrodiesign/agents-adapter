#!/usr/bin/env bash
# อ่าน configuration เดิมแล้ว classify เป็น managed / preserved / conflicting / unsafe / unknown
# ไม่แก้ไฟล์; ใช้ก่อน apply เพื่อ review ผลกระทบ
set -euo pipefail
cd "$(dirname "$0")/.."
node src/cli.ts migrate "$@"
echo
echo "== diff =="
node src/cli.ts diff "$@"

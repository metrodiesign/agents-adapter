#!/usr/bin/env bash
# ตัวเรียก probe จาก repo (source จริงอยู่ที่ runtime/shared/sandbox-probe.sh ซึ่ง apply ติดตั้งลง hooks dir ของแต่ละ CLI ด้วย)
set -euo pipefail
exec bash "$(dirname "$0")/../runtime/shared/sandbox-probe.sh" "$@"

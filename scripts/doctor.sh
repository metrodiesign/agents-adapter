#!/usr/bin/env bash
# ตรวจสุขภาพการติดตั้ง: version, conflict, credential exposure, hooks, extensions, drift, parity
# exit 1 เมื่อมี FAIL
set -euo pipefail
cd "$(dirname "$0")/.."
exec node src/cli.ts doctor "$@"

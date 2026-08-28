#!/usr/bin/env bash
# รัน permission matrix กับทุก adapter (TypeScript + Python) แล้วรายงาน parity
set -euo pipefail
cd "$(dirname "$0")/.."
node src/cli.ts verify "$@"
python3 -m unittest discover -s runtime/codex/hooks -p "test_*.py"

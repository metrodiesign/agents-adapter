#!/usr/bin/env bash
# secret และ private-data scan สำหรับ public repository
# ตรวจ: token/key pattern, credential file, private path (/Users/<name>, /home/<name>), connector id, trusted hash
# ใช้: scripts/secret-scan.sh            (สแกน tracked files ทั้งหมด)
#      scripts/secret-scan.sh --staged   (สแกนเฉพาะ staged diff ก่อน commit)
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-all}"
status=0

if [ "$MODE" = "--staged" ]; then
  FILES="$(git diff --cached --name-only --diff-filter=ACMR)"
else
  FILES="$(git ls-files)"
fi
[ -n "$FILES" ] || { echo "secret-scan: no files"; exit 0; }

# 1. ไฟล์ต้องห้าม
FORBIDDEN_FILES='(^|/)(\.env(\..*)?|auth\.json|credentials\.json|\.netrc|\.git-credentials|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|.*\.backup|.*\.bak|config\.yaml)$'
while IFS= read -r f; do
  case "$f" in
    *.env.example|*/.env.example|config/config.example.yaml) continue ;;
  esac
  if echo "$f" | grep -Eq "$FORBIDDEN_FILES"; then
    echo "FORBIDDEN FILE: $f"; status=1
  fi
done <<< "$FILES"

# 2. pattern ในเนื้อหา (ข้าม binary และ lock file)
PATTERNS='(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ANTHROPIC_AUTH_TOKEN=[^\s"]+|OPENAI_API_KEY=[^\s"]+|connector_[0-9a-f]{16,}|sha256:[0-9a-f]{64}|/Users/[a-z0-9_-]+/|/home/[a-z0-9_-]+/)'
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in
    package-lock.json|*.png|*.jpg|*.gif|*.ico|scripts/secret-scan.sh) continue ;;
  esac
  if grep -EnI "$PATTERNS" "$f" | grep -Ev '/Users/(<actual-user>|someone|example|\$USER)|/home/(someone|example|\$USER)' >/dev/null; then
    echo "SUSPICIOUS CONTENT in $f:"; grep -EnI "$PATTERNS" "$f" | grep -Ev '/Users/(<actual-user>|someone|example|\$USER)|/home/(someone|example|\$USER)' | sed -E 's/(ghp_|github_pat_|gho_|sk-|AKIA|xox[baprs]-)[A-Za-z0-9_-]+/\1<redacted>/g' | head -5
    status=1
  fi
done <<< "$FILES"

if [ "$status" -eq 0 ]; then echo "secret-scan: clean ($(echo "$FILES" | wc -l | tr -d ' ') files)"; fi
exit $status

#!/usr/bin/env bash
# agents-free-port.sh <port>
# ปลด TCP port ที่ dev/test server ค้างยึด โดย kill เฉพาะ listener ที่ working directory อยู่ใน repository ปัจจุบัน
# ติดตั้งโดย agents-adapter ลง hooks dir ของ CLI (sandbox เขียน dir นี้ไม่ได้) และรันนอก sandbox
# เพราะ seatbelt ปฏิเสธการส่ง signal ไป process นอก tree ของ sandbox (`kill -TERM` ตอบ `operation not permitted`)
# exit: 0 ปลดสำเร็จหรือไม่มี listener, 1 kill ไม่สำเร็จ, 2 argument ผิด, 3 ปฏิเสธ (cwd ไม่ใช่ git work tree, listener นอก repository),
#       4 ถูกเรียกจากใน sandbox (คำสั่งไม่ตรง pattern ที่ยกออกนอก sandbox: ต้องเรียกด้วย absolute path ไม่มี bash/sh นำหน้า)
set -euo pipefail

if [ -n "${SANDBOX_RUNTIME:-}" ] || [ -n "${CODEX_SANDBOX:-}" ]; then
  echo "refused: running inside the sandbox (SANDBOX_RUNTIME/CODEX_SANDBOX set); invoke by absolute path without bash/sh prefix (Codex: sandbox_permissions require_escalated)" >&2
  exit 4
fi

port="${1:-}"
if [ "$#" -ne 1 ] || ! [[ "$port" =~ ^[0-9]+$ ]]; then
  echo "usage: agents-free-port.sh <port>  (port must be a number in 1024-65535)" >&2
  exit 2
fi
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
  echo "refused: port $port is outside 1024-65535" >&2
  exit 2
fi

# ขอบเขต kill = git work tree ปัจจุบันเท่านั้น (ไม่ fallback เป็น cwd: zone root หรือ $HOME จะครอบ listener ของทุก repo)
if ! repo="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "refused: $(pwd -P) is not inside a git work tree; run from the repository whose dev server holds the port" >&2
  exit 3
fi
repo="$(cd "$repo" && pwd -P)"
home="$(cd "$HOME" && pwd -P)"
if [ "$repo" = "$home" ] || [ "$repo" = "/" ]; then
  echo "refused: $repo is not a project repository" >&2
  exit 3
fi

pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
if [ -z "$pids" ]; then
  echo "port $port: no listener"
  exit 0
fi

# ยังยึด port อยู่ไหม (ไม่ใช้ kill -0: process ที่ตายแล้วแต่ parent ยังไม่ reap เป็น zombie ซึ่ง kill -0 ยังตอบว่ามีอยู่)
listening() { lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -qx "$1"; }

status=0
for pid in $pids; do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  if [ -z "$cwd" ] && ! listening "$pid"; then
    # worker ที่ตายไปพร้อม parent ที่ถูก kill ก่อนหน้า (node cluster ฯลฯ): port ว่างแล้ว ไม่ใช่ความล้มเหลว
    echo "port $port: pid $pid already gone"
    continue
  fi
  case "$cwd" in
    "$repo" | "$repo"/*) ;;
    *)
      echo "refused: pid $pid on port $port has cwd '${cwd:-unknown}' outside $repo; ask the user to stop it" >&2
      status=3
      continue
      ;;
  esac
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    listening "$pid" || break
    sleep 0.5
  done
  if listening "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.5
  fi
  if listening "$pid"; then
    echo "failed: pid $pid on port $port is still alive" >&2
    status=1
  else
    echo "freed port $port: killed pid $pid (cwd $cwd)"
  fi
done
exit "$status"

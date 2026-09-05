#!/usr/bin/env bash
# ตรวจ capability ของ Bash sandbox ระดับ primitive (ไม่ผูกกับโปรเจกต์) แล้วรายงานต่อ probe:
#   PASS        ทำงานได้ใน sandbox
#   DENY(known) sandbox ปฏิเสธโดยตั้งใจหรือไม่มี key แก้ พร้อมทางเดินต่อที่ policy บอก agent ไว้แล้ว
#   FAIL        ต้องแก้ (policy ยังไม่ apply, token ยังไม่ตั้ง, หรือ regression)
#   SKIP        toolchain นั้นไม่มีในเครื่อง ไม่นับเป็น pass
# ใช้: bash scripts/sandbox-probe.sh   (รันจาก Claude/Codex session เพื่อวัดใน sandbox; รันจาก terminal ได้เพื่อเทียบ)
# script ทั้งตัวรันอยู่ใน sandbox เดียว (segment `bash ...` ไม่ match excludedCommands); docker/gh ถูกเรียกผ่าน sh -c
# เพื่อจำลองรูปที่ script ของโปรเจกต์เรียกเป็น process ลูก
set -u

fail=0
skip=0
report() { # level name detail
  printf '%-11s %-44s %s\n' "$1" "$2" "$3"
  case "$1" in FAIL) fail=$((fail + 1)) ;; SKIP) skip=$((skip + 1)) ;; esac
}
first_line() { printf '%s' "$1" | grep -v '^WARNING: Error loading config file' | grep -Ev '^(Traceback| +File | +[a-z].*\(|\s*$)' | grep -E 'rror|denied|permitted|not found|invalid|failed|refused|usage|Cannot connect|No such' | head -n 1 | cut -c1-160; }
has() { command -v "$1" >/dev/null 2>&1; }

probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-probe.XXXXXX")"
trap 'rm -rf "$probe_dir"; sh -c "docker image rm -f agents-adapter-probe:sandbox" >/dev/null 2>&1 || true' EXIT
echo "sandbox probe: TMPDIR=${TMPDIR:-unset} cwd=$(pwd) home=$HOME"
echo

# --- filesystem -------------------------------------------------------------
probe_write() { # name dir [alt-dir ...]: ใช้ dir แรกที่มีอยู่จริง (cache dir ต่างกันตาม OS/เวอร์ชันของ toolchain)
  local name="$1" dir="" d out
  shift
  for d in "$@"; do if [ -d "$d" ]; then dir="$d"; break; fi; done
  if [ -z "$dir" ]; then report SKIP "$name" "none of $* exists"; return; fi
  if out="$( (echo probe > "$dir/.agents-adapter-probe" && cat "$dir/.agents-adapter-probe" && rm -f "$dir/.agents-adapter-probe") 2>&1)"; then
    report PASS "$name" "write+read $dir"
  else
    report FAIL "$name" "$(first_line "$out")"
  fi
}
probe_write "fs: repo (cwd)" "$(pwd)"
probe_write "fs: \$TMPDIR" "${TMPDIR:-/tmp}"
has node && probe_write "fs: npm cache (node)" "$HOME/.npm" || report SKIP "fs: npm cache (node)" "node not installed"
has dotnet && probe_write "fs: nuget cache (dotnet)" "$HOME/.nuget/packages" || report SKIP "fs: nuget cache (dotnet)" "dotnet not installed"
has composer && probe_write "fs: composer cache (php)" "$HOME/Library/Caches/composer" "$HOME/.composer/cache" "$HOME/.cache/composer" || report SKIP "fs: composer cache (php)" "composer not installed"
has mvn && probe_write "fs: maven cache (java)" "$HOME/.m2" || report SKIP "fs: maven cache (java)" "mvn not installed"
has go && probe_write "fs: go module cache" "$HOME/go/pkg" || report SKIP "fs: go module cache" "go not installed"
has cargo && probe_write "fs: cargo cache (rust)" "$HOME/.cargo" || report SKIP "fs: cargo cache (rust)" "cargo not installed"
{ has uv || has pip3; } && probe_write "fs: python cache (uv/pip)" "$HOME/.cache" || report SKIP "fs: python cache (uv/pip)" "uv/pip3 not installed"
has docker && probe_write "fs: buildx state (docker)" "$HOME/.docker/buildx" || report SKIP "fs: buildx state (docker)" "docker not installed"
if out="$(cat "$HOME/.npmrc" 2>&1)"; then report FAIL "fs: credential ~/.npmrc" "readable inside the sandbox"
elif printf '%s' "$out" | grep -q 'No such file'; then report SKIP "fs: credential ~/.npmrc" "~/.npmrc absent: cannot tell whether the sandbox hides it"
else report "DENY(known)" "fs: credential ~/.npmrc" "$(first_line "$out")"; fi

# --- loopback + unix sockets (python3 socket primitives) ---------------------
if has python3; then
  py_probe() { # name python-snippet
    local out
    if out="$(python3 -c "$2" 2>&1)"; then report PASS "$1" "$out"; else report "${3:-FAIL}" "$1" "$(first_line "$out")"; fi
  }
  py_probe "net: bind+connect 127.0.0.1" 'import socket
s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(1); c=socket.create_connection(s.getsockname(),2); print("port",s.getsockname()[1])'
  py_probe "net: bind+connect ::1" 'import socket
s=socket.socket(socket.AF_INET6); s.bind(("::1",0)); s.listen(1); c=socket.socket(socket.AF_INET6); c.connect(("::1",s.getsockname()[1])); print("port",s.getsockname()[1])'
  py_probe "net: connect ::ffff:127.0.0.1 (v4-mapped)" 'import socket
s=socket.socket(socket.AF_INET6); s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,0); s.bind(("::",0)); s.listen(1)
c=socket.socket(socket.AF_INET6); c.connect(("::ffff:127.0.0.1",s.getsockname()[1])); print("ok; dotnet uses DOTNET_SYSTEM_NET_DISABLEIPV6=1 to avoid this path")' "DENY(known)"
  py_probe "net: bind AF_UNIX in \$TMPDIR" "import socket,os
p=os.path.join(os.environ.get('TMPDIR','/tmp'),'agents-adapter-probe.sock'); s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(1); os.unlink(p); print(p)"
  py_probe "net: bind AF_UNIX in /tmp" "import socket,os
p='/tmp/agents-adapter-probe-%d.sock'%os.getpid(); s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(1); os.unlink(p); print(p)"
else
  report SKIP "net: loopback/unix socket probes" "python3 not installed"
fi

# --- docker ------------------------------------------------------------------
if has docker; then
  if out="$(sh -c 'docker version --format "{{.Server.Version}}"' 2>&1)"; then
    report PASS "docker: daemon via socket (child process)" "server $(printf '%s' "$out" | tail -n 1)"
    printf 'FROM alpine:3.20\nRUN echo probe > /probe\n' > "$probe_dir/Dockerfile"
    # --pull บังคับให้ buildx ขอ registry token ฝั่ง client (Go TLS); image ถูกลบใน trap ท้าย script
    out="$(sh -c "docker build --pull -q -t agents-adapter-probe:sandbox '$probe_dir'" 2>&1)" && report PASS "docker: build --pull (buildx state + Go TLS)" "$(printf '%s' "$out" | tail -n 1 | cut -c1-40)" || report FAIL "docker: build --pull (buildx state + Go TLS)" "$(printf '%s' "$out" | grep -v '^WARNING' | grep -E 'ERROR|error|denied|permitted|tls' | head -n 1 | cut -c1-160)"
  elif printf '%s' "$out" | grep -q 'Cannot connect to the Docker daemon'; then
    report SKIP "docker: daemon via socket (child process)" "docker daemon not running (not a sandbox issue)"
    report SKIP "docker: build --pull (buildx state + Go TLS)" "docker daemon not running"
  else
    report FAIL "docker: daemon via socket (child process)" "$(first_line "$out")"
    report SKIP "docker: build --pull (buildx state + Go TLS)" "daemon probe failed"
  fi
else
  report SKIP "docker: daemon via socket (child process)" "docker not installed"
  report SKIP "docker: build --pull (buildx state + Go TLS)" "docker not installed"
fi

# --- gh (env prefix keeps it inside the sandbox) -----------------------------
if has gh; then
  out="$(env GH_NO_UPDATE_NOTIFIER=1 gh auth status 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then report PASS "gh: auth status (agent token, Go TLS)" "logged in via GH_CONFIG_DIR=${GH_CONFIG_DIR:-<unset>} (token never printed)"
  elif printf '%s' "$out" | grep -q 'OSStatus -26276'; then report FAIL "gh: auth status (agent token, Go TLS)" "$(first_line "$out") -> allowMachLookup com.apple.trustd.agent not active: apply + new session"
  elif printf '%s' "$out" | grep -qi 'not logged into any GitHub hosts'; then report FAIL "gh: auth status (agent token, Go TLS)" "no agent token in GH_CONFIG_DIR=${GH_CONFIG_DIR:-<unset>}: run the GitHub setup in docs/claude-adapter.md"
  elif printf '%s' "$out" | grep -q 'operation not permitted'; then report FAIL "gh: auth status (agent token, Go TLS)" "$(first_line "$out") -> GH_CONFIG_DIR not applied"
  else report FAIL "gh: auth status (agent token, Go TLS)" "$(printf '%s' "$out" | grep -v '^github.com' | head -n 1 | cut -c1-160)"; fi
else
  report SKIP "gh: auth status (agent token, Go TLS)" "gh not installed"
fi

# --- process enumeration / signal -------------------------------------------
out="$(pgrep -l -f sandbox-probe 2>&1)" && report PASS "proc: pgrep (sysmond lookup)" "$(printf '%s' "$out" | head -n 1)" || report FAIL "proc: pgrep (sysmond lookup)" "$(first_line "$out") -> allowMachLookup com.apple.sysmond not active: apply + new session"
out="$(/bin/ps -p $$ 2>&1)" && report FAIL "proc: /bin/ps (setuid)" "ps works: sandbox is not confining setuid exec" || report "DENY(known)" "proc: /bin/ps (setuid)" "$(first_line "$out"); use pgrep -lf / lsof"
# lsof คืน 1 เมื่อไม่มี listener จึงนับ 0/1 เป็นผ่าน; ห้ามต่อ pipe ก่อนอ่าน exit code
out="$(lsof -nP -iTCP -sTCP:LISTEN 2>&1)"; rc=$?
case $rc in 0 | 1) report PASS "proc: lsof listeners" "$(printf '%s' "$out" | sed -n 2p | cut -c1-60)" ;; *) report FAIL "proc: lsof listeners" "$(first_line "$out")" ;; esac
# signal ไป process ของ uid เดียวกันที่อยู่นอก tree ของ sandbox: ใช้ listener ตัวแรกของ user เป็นเป้า และส่ง SIGURG (default action = ignore)
# ห้ามใช้ pid 1: launchd เป็นของ root จึง EPERM เสมอแม้นอก sandbox
target="$(lsof -nP -u "$(id -u)" -a -iTCP -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | head -n 1)"
if [ -z "$target" ]; then report SKIP "proc: signal outside sandbox tree" "no same-uid listener to target"
elif out="$(kill -URG "$target" 2>&1)"; then report FAIL "proc: signal outside sandbox tree" "kill -URG $target succeeded: sandbox is not confining signals (expected only outside the sandbox)"
else report "DENY(known)" "proc: signal outside sandbox tree" "$(first_line "$out"); use agents-free-port.sh <port> for dev servers of this repo"; fi
for cli in claude codex; do
  w="$HOME/.$cli/hooks/agents-adapter/agents-free-port.sh"
  if ! has "$cli"; then report SKIP "proc: free-port wrapper ($cli)" "$cli not installed"
  elif [ -x "$w" ]; then report PASS "proc: free-port wrapper ($cli)" "$w"
  else report FAIL "proc: free-port wrapper ($cli)" "$w missing: apply --target $cli"; fi
done

# --- network egress per ecosystem registry ----------------------------------
egress() { # name host tool
  if [ -n "$3" ] && ! has "$3"; then report SKIP "$1" "$3 not installed"; return; fi
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "https://$2/" 2>&1)"
  case "$code" in [1-5][0-9][0-9]) report PASS "$1" "https://$2/ -> HTTP $code" ;; *) report FAIL "$1" "https://$2/ -> $(printf '%s' "$code" | head -n 1 | cut -c1-120)" ;; esac
}
egress "egress: github.com" github.com ""
egress "egress: registry.npmjs.org (node)" registry.npmjs.org node
egress "egress: api.nuget.org (dotnet)" api.nuget.org dotnet
egress "egress: repo.packagist.org (php)" repo.packagist.org composer
egress "egress: repo.maven.apache.org (java)" repo.maven.apache.org mvn
egress "egress: proxy.golang.org (go)" proxy.golang.org go
egress "egress: index.crates.io (rust)" index.crates.io cargo
egress "egress: pypi.org (python)" pypi.org python3
egress "egress: registry-1.docker.io (docker)" registry-1.docker.io docker

echo
echo "summary: FAIL=$fail SKIP=$skip (SKIP is not a pass)"
[ "$fail" -eq 0 ]

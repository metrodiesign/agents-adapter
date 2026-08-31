# Troubleshooting

## วิธีแยก layer

อาการเดียวกันเกิดได้จากหลายชั้น ให้ตรวจตามลำดับและอ้าง output จริง:

```text
policy (matrix / classifier)  -> node src/cli.ts verify
generated config              -> node src/cli.ts diff --target <cli>
CLI native enforcement        -> claude: /permissions /sandbox ; codex: codex doctor ; pi: pi list
hook / extension              -> doctor: hook availability, hook trust, extension availability
OS / credential store         -> macOS Files and Folders, keychain, gh auth status
```

## อาการและวิธีแก้

| อาการ | สาเหตุที่พบบ่อย | วิธีแก้ |
|---|---|---|
| `doctor` FAIL danger-full-access | ยังไม่ apply หรือ user แก้ config กลับ | `node src/cli.ts apply --target codex` แล้วดู `policy drift (codex)` |
| Codex ไม่ block `git push origin main` | hook ยังไม่ถูก trust หรือ `hooks.json` ไม่มี entry | เปิด codex แล้วยอมรับ hook; ตรวจ `doctor` hook trust |
| Codex hook แจ้ง `config not found` | `~/.codex/hooks/agents-adapter.config.json` หาย | `apply --target codex` |
| Pi ไม่ถามหรือไม่ block | extension ไม่ถูกโหลด (รันด้วย `-ne`) หรือไฟล์หาย | `pi list`, `apply --target pi`; ห้ามใช้ `--no-extensions` |
| Pi ASK กลายเป็น block ทันที | ไม่มี UI (print/rpc mode) = fail closed | รันแบบ interactive หรือให้ approval ล่วงหน้าไม่ได้ตาม policy |
| Claude ถาม `gh pr create` | `permissions.allow` ไม่มี entry (ยังไม่ apply) | `apply --target claude` |
| command ถูก ASK `SHELL_SUBSTITUTION` | มี `$(...)`, backtick, `$VAR` ที่ค่าไม่รู้ (positional, `read`, output ของ command) หรือ subshell | `for VAR in <literal>` และ `VAR=<literal>` ถูกขยายเป็นค่าจริงให้แล้ว; command ใน `$(...)` ถูก classify แยก (DENY ชนะ); `$(git rev-parse/merge-base/show-ref/rev-list ...)` ล้วน (flag ใน allowlist) ที่ส่งให้ command ที่ไม่ใช่ print/write/delete/`git push`, `$?`/`$$`/`$!`/`$#` และ `echo`/`printf` ที่ไม่ redirect ไม่ ASK แล้ว; backtick ใน double quote (เช่น regex `"```"`) ยังเป็น substitution ตาม bash ให้ใช้ single quote; ที่เหลือเขียน command ตรง ๆ หรือย้ายลง `scripts/x.sh` |
| Codex: `gh` หรือ `git push` ตาย `failed to load config: open ~/.config/gh/config.yml: operation not permitted` | permission profile ที่ติดตั้งยัง deny `~/.config/gh`; deny entry เป็น escalatable=false จึงแก้ด้วย `require_escalated` ไม่ได้ | `git pull` แล้ว `apply --target codex` (profile ใหม่ให้ `~/.config/gh` = read); agent ยังห้ามอ่านไฟล์ในนั้นเอง (hook DENY) |
| Codex: `gh` ตอบ `HTTP 401: Requires authentication` / `gh auth status` ใน sandbox ตอบ `The token in default is invalid` / `git push` ตาย `could not read Username for 'https://github.com': Device not configured` ทั้งที่นอก Codex ใช้ได้ | token ของ user อยู่ใน macOS keychain; seatbelt ของ Codex ปิด keychain ทั้งใน sandbox และ escalated (`codex sandbox --log-denials -- gh api user` แสดง `file-read-metadata .../login.keychain-db`) ไม่ใช่ `GH_TOKEN` stale และไม่ใช่ hook | ตั้ง agent token ตาม `docs/codex-adapter.md` (GitHub setup): fine-grained PAT ใน `~/.codex/gh` + `apply --target codex` (ตั้ง `GH_CONFIG_DIR`); `doctor` ต้อง `PASS gh agent token (codex)`; ถ้า `Bad credentials` แปลว่า token หมดอายุ/ถูก revoke ให้ rotate |
| Codex: ASK `UNKNOWN_COMMAND: apply_patch without file headers` ทุกครั้งที่แก้ไฟล์ | hook ที่ติดตั้งเป็นเวอร์ชันก่อนแก้ ซึ่งไม่รองรับ `tool_input` แบบ string ของ freeform `apply_patch` | `git pull` แล้ว `apply --target codex`; ถ้ายังเกิดแปลว่า patch ไม่มี `*** Add/Update/Delete File:` header (เช่น heredoc form) |
| ASK `OUTSIDE_TRUST_ZONE` บน `~/.agents/skills/...` | `~/.claude/skills` เป็น symlink ไป `~/.agents` ซึ่งไม่อยู่ใน `agent_config_dirs` | `git pull` แล้ว `apply`; `~/.agents` อยู่ใน trust zone แล้ว |
| path ในโปรเจกต์ถูก OUTSIDE_TRUST_ZONE | `development_roots` ไม่ครอบ path หรือเป็น symlink ออกนอก zone | แก้ config แล้ว apply |
| Claude: `git push`/`git fetch`/`gh` ตอบ `open ~/.config/gh/config.yml: operation not permitted` | ไม่มี segment ไหนในบรรทัด match `sandbox.excludedCommands` — การจับคู่ทำต่อ segment (`;`, `&&`, `\|`) ไม่ใช่ทั้งบรรทัด และหนึ่ง segment ที่ match ยกทั้งบรรทัดออกนอก sandbox (วัดจาก `$TMPDIR`: ใน sandbox = `/tmp/claude-<uid>`) กรณีที่เหลือคือ `gh`/`git` ถูกเรียกจาก script เป็น process ลูก ซึ่งไม่เคยได้รับการยกเว้น | ต่อ `&&`/pipe กับ `gh` ได้ ไม่ต้องแตกคำสั่ง; `apply --target claude` เพื่อให้มี pattern `rtk gh *`, `rtk git fetch *`; ถ้าเรียกจาก script ให้ย้าย `gh`/`git` มาเป็น segment บนสุด หรือขอ escalation ครั้งเดียวต่อคำสั่ง; ห้ามเปิด read `~/.config/gh` ให้ sandbox |
| Claude: script ที่เรียก `docker` ข้างในตอบ `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` | `excludedCommands` ตัดสินจากข้อความคำสั่ง process ลูกจึงยังอยู่ใน sandbox | `apply --target claude` (เติม `sandbox.network.allowUnixSockets` ให้ docker.sock ทั้งสอง path เหมือนที่ Codex ทำอยู่แล้ว) แล้วเปิด session ใหม่ |
| Claude: `dotnet test` ตอบ `vstest.console process failed to connect to testhost process` / `SocketException (13): Permission denied` | seatbelt ปฏิเสธ connect ไป v4-mapped IPv6 loopback (`::ffff:127.0.0.1`) ที่ .NET dual-stack socket ใช้ ไม่ใช่ loopback ถูกบล็อกทั้งหมด (`allowLocalBinding` เป็น true และ bind/connect `127.0.0.1`/`::1` ผ่าน) | `apply --target claude` (ตั้ง `env.DOTNET_SYSTEM_NET_DISABLEIPV6=1` เหมือนฝั่ง Codex) แล้วเปิด session ใหม่; ห้าม pipe ผลไป `tail`/`grep` เพราะ exit code หาย |
| Claude: `dotnet test`/`dotnet build` ของ solution ใหญ่ตอบ `MSBUILD : error MSB1025` + `SocketException (13): Permission denied` ที่ `NamedPipeServerStream` | MSBuild worker node คุยกันผ่าน named pipe ซึ่งบน Unix คือ AF_UNIX socket ใน temp dir; sandbox ปฏิเสธ `bind` ของ unix socket ทุก path ที่ไม่ได้ allow (probe: `socket.bind('$TMPDIR/probe.sock')` ตอบ `Operation not permitted`) | `apply --target claude` (allowUnixSockets มี `/tmp`, `/private/tmp` แล้ว) แล้วเปิด session ใหม่; ทางเลี่ยงชั่วคราวคือ `-m:1` เพื่อไม่ให้ MSBuild แตก worker node |
| Claude: `next build` ทำงานเหมือนไม่มี argument | rtk hook rewrite `next build` เป็น `rtk next` (argument หาย); rtk ยัง rewrite `cat`/`head`/`tail` เป็น `rtk read` | ปิด rewrite รายคำสั่งที่ `~/Library/Application Support/rtk/config.toml` → `[hooks] exclude_commands` |
| Claude: `apply` ถูก auto mode classifier block | เขียน `~/.claude/settings.json` ซึ่ง Claude กันจาก agent | user รันเองด้วย `! node src/cli.ts apply --target claude --yes` |
| autoMode มีข้อความ `YOUR_GITHUB_USER` ซ้ำ | apply ด้วย config example ที่ยังไม่แก้ | แก้ `github.owner` ใน config แล้ว `apply`; managed state ลบ entry เก่าให้ |
| Claude: ไฟล์ใน `$TMPDIR` หายเมื่อคำสั่งถัดไปรันด้วย `dangerouslyDisableSandbox` (เช่น `git commit -F $TMPDIR/msg`) | `$TMPDIR` ใน sandbox = `/tmp/claude-<uid>` แต่นอก sandbox = `getconf DARWIN_USER_TEMP_DIR` | เขียนไฟล์ชั่วคราวใน scratchpad ของ session หรือใช้ `-m`/heredoc; managed block ของ CLAUDE.md บอก agent แล้ว |
| Claude: `npm run ...` ใน pre-commit/hook ล้มและ log อ้าง `~/.npmrc` `Operation not permitted` | sandbox บังอ่าน credential path (`~/.npmrc`, `~/.netrc`, `~/.pypirc`) โดยตั้งใจ; npm เองทน EPERM ที่ userconfig ได้ (`npm config get registry` ใน sandbox ผ่าน) แต่ tool ที่ `fs.readFileSync(~/.npmrc)` ตรง ๆ จะล้ม | เก็บ error บรรทัดจริงและชื่อ tool; ถ้า tool ต้องอ่านจริงให้ตั้ง `NPM_CONFIG_USERCONFIG=/dev/null` เฉพาะคำสั่งนั้น ห้ามเพิ่ม `~/.npmrc` ใน sandbox allow |
| `doctor` รายงาน drift ที่ `agents-adapter.config.json` ทั้ง 3 CLI เฉพาะเมื่อรันจากใน Claude/Codex session | `tmpdir` ใน context เคยตามค่า `$TMPDIR` ของ shell | `git pull`; ตอนนี้ใช้ `getconf DARWIN_USER_TEMP_DIR` จึงเท่ากันทุก shell |
| `doctor` รายงาน hash drift ของ Claude ใต้ codex/pi | build ก่อน PR #7 วน hash ทุกไฟล์ไม่กรอง target | `git pull` แล้วรัน doctor ใหม่ |
| subagent ตอบ `400 This content was flagged for possible cybersecurity risk` ซ้ำทุก request | รัน security agent ผ่าน proxy ไป provider อื่น (`ANTHROPIC_BASE_URL`); context ถูกแฟล็กถาวร | kill agent ตัวนั้นทันที ห้าม resume; spawn ใหม่บน `claude` ปกติ; หลัง apply hook `provider_guard.py` จะ deny การ spawn แบบนี้ตั้งแต่ต้น |
| Claude: spawn auditor ถูก deny `SECURITY_AGENT_PROVIDER` ทั้งที่ตั้งใจใช้ proxy | policy กันไว้ตามออกแบบ | รัน audit ใน session Claude ปกติ หรือเปลี่ยนชื่อ agent ให้อยู่นอก `security_agent_types` เฉพาะเมื่อ prompt ไม่มีเนื้อหา security จริง |
| Codex: ASK `unknown command: bash` เมื่อรัน `bash scripts/x.sh` | classifier unwrap เฉพาะ `bash -c`; รูป `bash <script>` ตกไป UNKNOWN_COMMAND | `git pull` แล้ว `apply --target codex`; ตอนนี้ตัดสินจาก path ของ script (ใน zone = ALLOW BUILD) |
| Codex: ASK `unknown tool: collaborationwait_agent` (หรือ `spawn_agent`, `list_agents`, `update_plan`) | Codex ส่ง namespace ติดกับชื่อ tool; classifier ไม่รู้จัก | `git pull` แล้ว `apply --target codex`; collaboration tools = `AGENT_SPAWN` ALLOW (spawn ยังผ่าน provider guard) |
| Codex: ASK `unknown command: for` (หรือ `while`, `if`, `!`, `{`) | shell keyword ถูกอ่านเป็นชื่อ command | `git pull` แล้ว `apply --target codex`; ตอนนี้ตัดสินจาก command ในตัว loop/if แทน (body ที่มี `$VAR` ยัง ASK SHELL_SUBSTITUTION ตามเดิม) |
| DENY หรือ `Operation not permitted` บน `.env.prod.example` | pattern `.env.prod.*` จับ template ค่าปลอมด้วย ทั้งใน classifier และ native glob (Claude `permissions.deny`, Codex sandbox) ที่ไม่มี negation | `git pull` แล้ว `apply --target all`; classifier ยกเว้น `.example`/`.sample`/`.dist`/`.template`; native glob เปลี่ยนเป็นชุด suffix เจาะจง (`.local`, `.bak`, `.backup`, `.old`, `.orig`, `.secret`, `.secrets`, `.enc`, `.vault`, `.live`) ชื่อนอกชุดนี้ยังโดน hook จับผ่าน wildcard แต่ sandbox ไม่กัน |
| Codex: `PreToolUse hook returned updatedInput without permissionDecision:allow` | entry `rtk hook claude` ใน `~/.codex/hooks.json` (matcher `Bash`) ตอบรูปแบบของ Claude ซึ่ง Codex ไม่รับ; ไม่ใช่ hook ของ agents-adapter | ลบ entry นั้นออกจาก `hooks.json` (rtk ไม่มี `hook codex`) |
| `apply` ล้มด้วย validation error | ไฟล์เดิม parse ไม่ได้ (JSON/TOML) | แก้ไฟล์ให้ถูกต้องก่อน; agents-adapter ไม่แทนที่ไฟล์ที่ validate ไม่ผ่าน |
| `rollback` รายงาน failed บางไฟล์ | สิทธิ์ไฟล์หรือไฟล์ถูกล็อก | แก้สิทธิ์แล้วรัน rollback ซ้ำ; backup ยังอยู่ |
| generate-check CI fail | render output เปลี่ยนหลังแก้ policy | `node src/cli.ts generate-check` แล้ว commit `tests/fixtures/generated` |
| secret-scan fail | private path/token ใน diff | ลบหรือแทนด้วย placeholder; ห้าม commit ค่าจริง |

## คำสั่งตรวจสอบ

```bash
node src/cli.ts doctor --json
node src/cli.ts verify
node src/cli.ts diff --target codex
node src/cli.ts rollback --check
python3 -m unittest discover -s runtime/codex/hooks -p "test_*.py"
```

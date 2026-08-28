# Pi Adapter

Pi ไม่มี permission layer ใน `settings.json`; agents-adapter ใช้ extension เป็น policy gate และ OS isolation profile สำหรับ hard boundary ระดับ credential

## ไฟล์ที่ generate

| ไฟล์ | บทบาท |
|---|---|
| `~/.pi/agent/extensions/policy-gate.ts` | intercept `tool_call` ทุก tool (bash, read, write, edit, grep, glob, ls, ...) |
| `~/.pi/agent/extensions/protected-paths.ts` | ชั้นที่สองสำหรับ credential/production env บน file tool |
| `~/.pi/agent/extensions/user-bash-gate.ts` | intercept `user_bash` (`!command`, `!!command`) |
| `~/.pi/agent/extensions/share-guard.ts` | block `/share` ผ่าน `input` event และ share tool |
| `~/.pi/agent/extensions/agents-adapter-lib/` | `shared.ts` + `core/*.ts` (copy ของ `src/core`) + `config.json` (PolicyContext) |
| `~/.pi/agent/AGENTS.md` | managed block |
| `~/.pi/agent/agents-adapter-isolation.yaml` | profile ที่เลือกใน config (`pi.isolation_mode`) |
| `~/.pi/agent/settings.json` | ตรวจว่า JSON ถูกต้อง; ไม่มี managed key เพราะ Pi auto-discover extension จาก `~/.pi/agent/extensions` |

## Enforcement ใน extension

```text
ALLOW -> return undefined (ทำต่อ)
ASK   -> ctx.ui.confirm(title, "action + target + risk") ; cache ต่อ session ตาม rule + target + environment
DENY  -> { block: true, reason: "agents-adapter DENY [RULE_ID]: ..." }
```

- ไม่มี UI (print mode) = fail closed: ASK กลายเป็น block
- `user_bash` ไม่มี block flag ใน Pi API จึงคืน `result` (exitCode 1 + ข้อความ) แทนการรัน
- `/share` ถูก `input` handler ตอบ `{ action: "handled" }` พร้อม notify

## Isolation profiles

| profile | ใช้กับ | credential/prod env |
|---|---|---|
| `host-macos` | Xcode, Simulator, Keychain ผ่าน CLI เจ้าของ credential, Docker Desktop, GUI, gh | best-effort (extension เท่านั้น) |
| `docker` | Node.js, PHP, .NET, Python, backend, database, test, repository analysis | isolation: mount เฉพาะ development root + Pi extension/config แบบ read-only; ไม่ mount `~/.ssh`, `~/.aws`, `~/.config/gh`, auth.json, docker.sock |
| `gondolin`, `openshell` | เหมือน docker เมื่อเครื่องมี runtime นั้น | isolation |

launcher: `scripts/pi-isolated.sh docker [pi args]` รันจาก root ของ repository ที่ต้องการทำงาน

`agents-adapter verify` และ doctor รายงาน UNSUPPORTED เมื่อ host mode ไม่มี isolation runtime ให้ fallback; parity test มี negative case สำหรับสถานการณ์นี้

## Evaluator

`src/adapters/pi/evaluate.ts` เรียก handler จริงของ extension (`gateToolCall`, `gateUserBash`, `guardInput`, `protectedPathCheck`) ด้วย fake context ที่ไม่มี UI แล้วแปลง block reason กลับเป็น verdict ดังนั้น parity ทดสอบโค้ดที่ถูกติดตั้งจริง

## ข้อจำกัด

- user ที่รัน `pi --no-extensions` เองบน host จะไม่มี gate; policy ห้าม (`SAFETY_BYPASS`) แต่บังคับไม่ได้บน host
- โค้ดที่ model เขียนแล้วรัน (`python3 script.py`) ผ่าน gate เป็น `BUILD`; เนื้อหา script ไม่ถูกวิเคราะห์ จึงต้องใช้ isolated profile เมื่อทำงานกับ credential-sensitive environment

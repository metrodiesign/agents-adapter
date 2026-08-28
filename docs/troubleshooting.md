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
| command ถูก ASK ทั้งที่ควร ALLOW | มี `$(...)`, backtick, `$VAR` หรือ subshell | เขียน command ตรง ๆ โดยไม่ใช้ substitution |
| path ในโปรเจกต์ถูก OUTSIDE_TRUST_ZONE | `development_roots` ไม่ครอบ path หรือเป็น symlink ออกนอก zone | แก้ config แล้ว apply |
| Claude: `git push`/`git fetch`/`gh` ตอบ `open ~/.config/gh/config.yml: operation not permitted` | คำสั่งไม่ match `sandbox.excludedCommands` (compound command, pipe หรือ rtk rewrite เป็น `rtk ...`) | รัน `gh` เป็นคำสั่งเดี่ยว; `apply --target claude` เพื่อให้มี pattern `rtk gh *`, `rtk git fetch *`; ห้ามเปิด read `~/.config/gh` ให้ sandbox |
| Claude: `apply` ถูก auto mode classifier block | เขียน `~/.claude/settings.json` ซึ่ง Claude กันจาก agent | user รันเองด้วย `! node src/cli.ts apply --target claude --yes` |
| autoMode มีข้อความ `YOUR_GITHUB_USER` ซ้ำ | apply ด้วย config example ที่ยังไม่แก้ | แก้ `github.owner` ใน config แล้ว `apply`; managed state ลบ entry เก่าให้ |
| `doctor` รายงาน hash drift ของ Claude ใต้ codex/pi | build ก่อน PR #7 วน hash ทุกไฟล์ไม่กรอง target | `git pull` แล้วรัน doctor ใหม่ |
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

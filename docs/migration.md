# Migration

## ขั้นตอน

```bash
scripts/migrate-existing.sh        # อ่าน config เดิม classify + แสดง diff (ไม่แก้ไฟล์)
node src/cli.ts plan --target all  # ตรวจ managed keys / preserved / conflict / unsupported / backup destination
node src/cli.ts apply --target all # backup -> atomic write -> state
scripts/doctor.sh
```

## การ classify configuration เดิม

| class | ความหมาย | ตัวอย่าง |
|---|---|---|
| managed | key/block ที่ agents-adapter เป็นเจ้าของและจะ generate ทับ | `permissions.deny` entries ของ matrix, `sandbox_mode` (ลบ), hooks entries |
| preserved | ค่าของ user ที่ไม่แตะ | `model`, `notify`, `projects.*`, `plugins.*`, `hooks.state`, hooks ของ user, unknown keys |
| conflicting | ค่าของ user ที่ขัดกับ policy และถูกแก้ | `sandbox_mode = "danger-full-access"`, `"/" = "read"`, `~/.config/gh = read`, `**/.env = deny` |
| unsafe | conflict ที่เปิดช่องโหว่ | danger-full-access, root read, gh config readable |
| unknown | สิ่งที่ adapter ตรวจไม่ได้หรือ CLI version ไม่รองรับ | ไม่มี GitHub connector ใน `[apps]`, settings.json ของ Pi ไม่ใช่ JSON |

## Conflict ที่ตรวจ

- Codex `default_permissions` + `sandbox_mode`
- `danger-full-access` enabled (config หรือ CLI flag ผ่าน `SAFETY_BYPASS`)
- filesystem `"/"` read
- development env ถูก deny ทั้งหมด
- GitHub credential path (`~/.config/gh`) readable
- Pi ไม่มี policy extension
- unsupported config keys / invalid JSON
- hardcoded user path และ connector id (ใน repository: secret-scan; ในเครื่อง: config json ของ hook ไม่มี connector id)

## Backup และ rollback

- backup ก่อน apply ทุกครั้งที่ `${HOME}/.local/state/agents-adapter/backups/<timestamp>/` พร้อม `manifest.json` (path, sha256, existed)
- `apply` เขียนแบบ temp file -> validate -> fsync -> rename; validation ไม่ผ่าน = ไม่แทนที่ไฟล์จริง
- `rollback` ตรวจ checksum ของ backup ทุกไฟล์ก่อนเริ่มเขียน แล้วคืนทุกไฟล์จาก backup เดียวกัน; ไฟล์ที่สร้างใหม่ถูกลบ; ถ้าคืนบางไฟล์ไม่ได้จะรายงานและไม่ลบ backup
- `uninstall` ถอนเฉพาะ managed content (มี backup ก่อน); ไม่คืน `sandbox_mode` ที่เป็น conflict เดิม

## Idempotency

`apply` ซ้ำโดยไม่มี policy change ให้ `no changes` (`tests/integration/install.test.ts`); block/hook/rule ไม่ถูกเพิ่มซ้ำ; stale managed entries จาก policy เวอร์ชันก่อนถูกลบด้วย state

## หลัง migration บน Codex

1. เปิด `codex` หนึ่งครั้งเพื่อ trust hooks ใหม่ (`hooks.state` จะได้ trusted_hash)
2. ถ้าต้องการบังคับ `requirements.toml` ระดับเครื่อง ให้ copy `~/.codex/requirements.toml` ไป `/etc/codex/requirements.toml` (ต้องใช้สิทธิ์ admin; agents-adapter ไม่ทำให้อัตโนมัติ)
3. รัน `scripts/doctor.sh` ตรวจว่า danger-full-access, root read และ credential exposure เป็น PASS

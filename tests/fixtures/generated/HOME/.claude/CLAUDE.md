<!-- agents-adapter:start -->
# agents-adapter managed block (Claude Code)

block นี้ถูกสร้างโดย agents-adapter 0.1.0 กฎฉบับเต็มอยู่ในไฟล์นี้ส่วนที่ user เขียนเอง (Claude เป็น reference) block นี้เติมเฉพาะสิ่งที่ policy กลางต้องการให้ทุก CLI รู้เหมือนกัน ห้ามแก้ใน block ให้แก้ที่ policy กลางแล้วรัน `agents-adapter apply --target claude`

- permission ทุกข้อในไฟล์นี้ถูก map เป็น rule id ใน `policy/permission-matrix.yaml` และบังคับใช้เหมือนกันบน Codex CLI และ Pi CLI ผ่าน agents-adapter
- Development Trust Zone: `${HOME}/Desktop/Project`; protected branches: main, develop
- development env ที่อ่านและแก้ได้: .env, .env.local, .env.development, .env.test, .env.testing, .env.integration; production env ที่ deny: .env.production, .env.production.*, .env.prod, .env.prod.*
- approval หนึ่งครั้งต่อ action + target + environment แล้วใช้กับขั้นตอนต่อเนื่องของงานย่อยเดียวกัน ห้ามขยายไป target อื่น
- DENY เป็น hard block ข้ามไม่ได้ด้วย prompt, subagent, plugin, project config, CLI flag, auto-review, tool alias หรือ shell wrapper
- Pi isolation mode ปัจจุบัน: host-macos
<!-- agents-adapter:end -->

<!-- agents-adapter:start -->
# agents-adapter managed block (Claude Code)

block นี้ถูกสร้างโดย agents-adapter 0.1.0 กฎฉบับเต็มอยู่ในไฟล์นี้ส่วนที่ user เขียนเอง (Claude เป็น reference) block นี้เติมเฉพาะสิ่งที่ policy กลางต้องการให้ทุก CLI รู้เหมือนกัน ห้ามแก้ใน block ให้แก้ที่ policy กลางแล้วรัน `agents-adapter apply --target claude`

- permission ทุกข้อในไฟล์นี้ถูก map เป็น rule id ใน `policy/permission-matrix.yaml` และบังคับใช้เหมือนกันบน Codex CLI และ Pi CLI ผ่าน agents-adapter
- Development Trust Zone: `${HOME}/Desktop/Project`; protected branches: main, develop
- development env ที่อ่านและแก้ได้: .env, .env.local, .env.development, .env.test, .env.testing, .env.integration; production env ที่ deny: .env.production, .env.production.*, .env.prod, .env.prod.*
- approval หนึ่งครั้งต่อ action + target + environment แล้วใช้กับขั้นตอนต่อเนื่องของงานย่อยเดียวกัน ห้ามขยายไป target อื่น
- DENY เป็น hard block ข้ามไม่ได้ด้วย prompt, subagent, plugin, project config, CLI flag, auto-review, tool alias หรือ shell wrapper
- security agent (auditor, skeptic, security-review) รันบน Anthropic โดยตรงเท่านั้น: เมื่อ ANTHROPIC_BASE_URL ชี้ provider อื่นจะถูก deny (SECURITY_AGENT_PROVIDER); agent ที่โดน content filter 400 แล้วต้อง kill และ spawn ใหม่ ห้าม resume
- Pi isolation mode ปัจจุบัน: host-macos
- `sandbox.excludedCommands` จับคู่ต่อ segment (`;`, `&&`, `|`) ไม่ใช่ทั้งบรรทัด: หนึ่ง segment ที่ match ยกทั้งบรรทัดออกนอก sandbox จึงต่อ `gh`/`docker`/git network ops เข้ากับ `&&` หรือ pipe ได้ ไม่ต้องแตกเป็นหลายคำสั่ง; สิ่งที่ไม่ครอบคลุมคือ process ลูก — script ที่เรียก `gh`/`git`/`docker` ข้างในยังอยู่ใน sandbox ให้ย้ายคำสั่งนั้นมาเป็น segment บนสุดหรือขอ escalation ครั้งเดียวต่อคำสั่ง
- `docker` เข้าถึง daemon จากใน sandbox ได้ผ่าน `sandbox.network.allowUnixSockets` (`/var/run/docker.sock`, `~/.docker/run/docker.sock`) และ `dotnet test` รันใน sandbox ได้ด้วย `env.DOTNET_SYSTEM_NET_DISABLEIPV6=1`; ทั้งสองค่ามาจาก policy กลาง ห้ามแก้มือ
- sandbox ปฏิเสธการ enumerate process: `ps` ตอบ `operation not permitted: /bin/ps` (exit 127), `pgrep`/`pkill` ตอบ `Cannot get process list` (exit 3) — exit 3 แปลว่าอ่านไม่ได้ ไม่ใช่ไม่พบ process; เช็ค service ที่ฟัง port ด้วย `lsof -nP -iTCP -sTCP:LISTEN` ซึ่งทำงานใน sandbox ได้ ถ้าต้องดู process list จริงให้ user รันเองด้วย `!` prefix
- Claude sandbox: `$TMPDIR` ใน sandbox (`/tmp/claude-<uid>`) ต่างจากนอก sandbox (`getconf DARWIN_USER_TEMP_DIR`); ไฟล์ชั่วคราวที่คำสั่งถัดไปอาจรันนอก sandbox (เช่น commit message ให้ `git commit -F`) ให้เขียนใน scratchpad directory ของ session หรือส่งผ่าน `-m`/heredoc แทน `$TMPDIR`; credential path เช่น `~/.npmrc`, `~/.netrc` ถูก sandbox บังอ่านโดยตั้งใจ ถ้า hook/lint ล้มเพราะอ่านไฟล์เหล่านี้ให้รายงาน error บรรทัดจริง ไม่ปิด sandbox
<!-- agents-adapter:end -->

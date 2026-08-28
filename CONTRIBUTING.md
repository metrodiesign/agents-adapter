# Contributing

## หลักการ

- Claude reference เป็น behavioral source; `policy/permission-matrix.yaml` เป็น contract; adapter เป็นการแปลง; parity test เป็นหลักฐาน
- สิ่งที่เป็น Claude-only, Codex-only หรือ Pi-only ต้องอยู่ใน adapter ของ CLI นั้น ห้ามใส่ใน policy กลาง
- rule id คงที่ ห้ามเปลี่ยนชื่อ; เพิ่ม rule ใหม่แทน

## ขั้นตอน

1. fork แล้วสร้าง feature branch (ห้าม push ตรงเข้า `main`)
2. แก้ policy หรือ adapter ตามลำดับ: reference -> matrix + provenance -> classifier (TS และ Python) -> fixture -> adapter -> docs
3. รัน `npm run check` ให้ผ่านทั้งหมด
4. เปิด pull request ตาม template พร้อม test evidence

## คำสั่งที่ต้องผ่าน

```bash
npm run typecheck
npm test
npm run test:python
npm run lint:md
npm run lint:data
npm run secret-scan
node src/cli.ts generate-check --check
```

## กติกาเอกสาร

- ไฟล์ `.md` เป็นภาษาไทยเป็นหลัก; technical term, command, identifier และ code เป็นภาษาอังกฤษ
- ห้ามใช้ emoji
- code block ต้องระบุภาษา

## Dependency

- เพิ่ม dependency ใหม่ต้องระบุ license, maintenance status และเหตุผลใน PR
- pin เวอร์ชันแบบเจาะจงใน `package.json` และ commit `package-lock.json`

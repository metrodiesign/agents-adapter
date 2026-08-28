# Pull Request

## สรุปการเปลี่ยนแปลง

- 

## ผลกระทบต่อ policy

- [ ] แก้ Claude reference (reference/claude) หรือไม่
- [ ] แก้ permission-matrix.yaml หรือไม่ (rule id ใหม่ต้องมี provenance และ fixture)
- [ ] แก้ adapter (claude / codex / pi) หรือไม่
- [ ] เพิ่มหรือแก้ parity fixture หรือไม่

## Test evidence

```text
npm run check
```

## Checklist

- [ ] ไม่มี credential, private path, connector id หรือ trusted hash ใน diff
- [ ] `npm run secret-scan` ผ่าน
- [ ] parity ผ่านทั้งสาม CLI หรือระบุ UNSUPPORTED พร้อม isolation fallback
- [ ] เอกสาร `.md` เป็นภาษาไทยและไม่มี emoji

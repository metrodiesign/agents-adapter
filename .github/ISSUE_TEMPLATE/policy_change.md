---
name: Policy change
about: เสนอเพิ่มหรือแก้ rule ใน permission matrix
labels: policy
---

# Policy change

## rule ที่เสนอ

- rule id:
- decision: ALLOW / ASK / DENY
- category:

## เหตุผลและที่มา (provenance)

- Claude reference section:

## adapter ที่ต้องแก้

- [ ] claude
- [ ] codex
- [ ] pi

## fixture ที่จะเพิ่ม

```json
{ "id": "RULE_ID", "name": "...", "kind": "command", "command": "...", "expected": "DENY" }
```

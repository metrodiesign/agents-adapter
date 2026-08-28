import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { formatParity, runParity } from "../../src/parity/harness.ts";
import { makeTestEnv } from "../helpers.ts";

test("all adapters agree with the matrix and with each other on every fixture", async () => {
  const t = makeTestEnv();
  try {
    const r = await runParity(t.env, { world: t.world });
    assert.equal(r.failures.length, 0, formatParity(r));
    assert.ok(r.byDecision.ALLOW > 0 && r.byDecision.ASK > 0 && r.byDecision.DENY > 0);
  } finally {
    t.cleanup();
  }
});

test("no required rule is UNSUPPORTED without an isolation fallback", () => {
  const t = makeTestEnv();
  try {
    const detected = { claudeVersion: "2.1.0", codexVersion: "0.150.0", piVersion: "0.84.0", docker: true, gondolin: false, openshell: false, python3: true, ghAuthenticated: true };
    for (const adapter of Object.values(ADAPTERS)) {
      const caps = adapter.capabilities(t.env, detected);
      const unsupported = Object.entries(caps).filter(([, c]) => c.level === "unsupported").map(([k]) => k);
      assert.deepEqual(unsupported, [], `${adapter.name} unsupported: ${unsupported.join(", ")}`);
      for (const [id, c] of Object.entries(caps)) if (c.level === "best-effort") assert.equal(c.fallback, "isolation", `${adapter.name} ${id} best-effort without fallback`);
    }
  } finally {
    t.cleanup();
  }
});

test("Pi host mode without any isolation runtime reports UNSUPPORTED for credential rules", () => {
  const t = makeTestEnv();
  try {
    const detected = { claudeVersion: "2.1.0", codexVersion: "0.150.0", piVersion: "0.84.0", docker: false, gondolin: false, openshell: false, python3: true, ghAuthenticated: true };
    const caps = ADAPTERS.pi.capabilities(t.env, detected);
    assert.equal(caps.CREDENTIAL_READ.level, "unsupported");
  } finally {
    t.cleanup();
  }
});

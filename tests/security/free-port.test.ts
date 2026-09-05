import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../../src/core/policy-loader.ts";

const WRAPPER = path.join(REPO_ROOT, "runtime", "shared", "agents-free-port.sh");

function run(args: string[], cwd: string): { status: number | null; out: string } {
  // test อาจรันอยู่ใน Claude sandbox (SANDBOX_RUNTIME=1) ซึ่ง wrapper ปฏิเสธโดยตั้งใจ: ตัด marker ออกเพื่อทดสอบ logic ที่เหลือ
  const { SANDBOX_RUNTIME: _s, CODEX_SANDBOX: _c, ...env } = process.env;
  const r = spawnSync("bash", [WRAPPER, ...args], { cwd, encoding: "utf8", env });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
}

function listeners(port: number): string[] {
  const r = spawnSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return r.stdout.split("\n").filter(Boolean);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** listener ที่ cwd กำหนดได้ (process ลูกของ test อยู่ใน sandbox เดียวกัน จึง signal ได้แม้รันใน Claude sandbox) */
function listen(port: number, cwd: string): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1", () => process.stdout.write("ready\\n"))`], { cwd, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout?.once("data", () => resolve(child));
    child.once("exit", (code) => reject(new Error(`listener exited ${code}`)));
  });
}

function hasLsof(): boolean {
  return spawnSync("sh", ["-c", "command -v lsof"]).status === 0;
}

test("free-port wrapper refuses to run inside a sandbox (command did not match the unsandboxed pattern)", () => {
  const r = spawnSync("bash", [WRAPPER, "3001"], { cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, SANDBOX_RUNTIME: "1" } });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /refused: running inside the sandbox/);
});

test("free-port wrapper rejects bad arguments and privileged ports", () => {
  const cwd = os.tmpdir();
  assert.equal(run([], cwd).status, 2);
  assert.equal(run(["abc"], cwd).status, 2);
  assert.equal(run(["3001", "3002"], cwd).status, 2);
  assert.equal(run(["80"], cwd).status, 2);
  assert.equal(run(["70000"], cwd).status, 2);
  assert.equal(run(["3001;id"], cwd).status, 2);
});

test("free-port wrapper kills a listener of the current repository and refuses one from elsewhere", { skip: !hasLsof() && "lsof not available" }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agents-adapter-free-port-"));
  const repo = path.join(base, "repo");
  const other = path.join(base, "other");
  fs.mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
  const port = await freePort();
  // no listener -> exit 0
  assert.equal(run([String(port)], repo).status, 0);
  // listener whose cwd is outside the repo -> refused (exit 3), still alive
  const outsider = await listen(port, other);
  try {
    const refused = run([String(port)], repo);
    assert.equal(refused.status, 3, refused.out);
    assert.match(refused.out, /refused: pid \d+ on port \d+ has cwd/);
    assert.equal(outsider.exitCode, null, "outsider must not be killed");
  } finally {
    outsider.kill("SIGKILL");
    await new Promise((r) => outsider.once("exit", r));
  }
  // cwd ที่ไม่ใช่ git work tree (zone root, $HOME): ต้องปฏิเสธ ไม่ fallback เป็น cwd แล้วครอบ listener ของทุก repo ข้างใต้
  const outsider2 = await listen(port, repo);
  try {
    const notGit = run([String(port)], base);
    assert.equal(notGit.status, 3, notGit.out);
    assert.match(notGit.out, /refused: .* is not inside a git work tree/);
    assert.equal(outsider2.exitCode, null, "listener under a non-git cwd must survive");
  } finally {
    outsider2.kill("SIGKILL");
    await new Promise((r) => outsider2.once("exit", r));
  }
  // listener started from a subdirectory of the repo -> killed (exit 0)
  const insider = await listen(port, path.join(repo, "apps", "web"));
  const exited = new Promise<void>((r) => insider.once("exit", () => r()));
  const freed = run([String(port)], repo);
  assert.equal(freed.status, 0, freed.out);
  assert.match(freed.out, /freed port \d+: killed pid \d+/);
  await exited;
  // node cluster (SCHED_NONE): primary และ worker ถือ listening socket ทั้งคู่; kill primary ทำให้ worker ตายตาม
  // wrapper ต้องไม่ abort ด้วย set -e/pipefail เมื่อ lsof ของ pid ที่หายไปแล้วคืน 1 (รายงาน "already gone" และ exit 0)
  const clusterScript = path.join(base, "cluster.cjs");
  fs.writeFileSync(clusterScript, `const c=require("cluster");c.schedulingPolicy=c.SCHED_NONE;if(c.isPrimary){c.fork();c.on("listening",()=>process.stdout.write("ready\\n"))}else{require("net").createServer().listen(Number(process.argv[2]),"127.0.0.1")}`);
  const cluster = spawn(process.execPath, [clusterScript, String(port)], { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    cluster.stdout?.once("data", () => resolve());
    cluster.once("exit", (code) => reject(new Error(`cluster exited ${code}`)));
  });
  const clusterExit = new Promise<void>((r) => cluster.once("exit", () => r()));
  const freedCluster = run([String(port)], repo);
  assert.equal(freedCluster.status, 0, freedCluster.out);
  await clusterExit;
  assert.deepEqual(listeners(port), [], "port must be free after the cluster is killed");
  fs.rmSync(base, { recursive: true, force: true });
});

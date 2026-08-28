// Markdown lint แบบเบา: ห้าม emoji, ต้องมี H1, code block ต้องระบุภาษา, ไม่มี private path
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/u;
const PRIVATE = /\/Users\/[a-z0-9_-]+\/|\/home\/[a-z0-9_-]+\//;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

let problems = 0;
for (const file of walk(process.cwd())) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (!lines.some((l) => /^# /.test(l))) report(file, 0, "missing H1 heading");
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^```/.test(line)) {
      if (!inFence && line.trim() === "```") report(file, i + 1, "code block without language");
      inFence = !inFence;
      return;
    }
    if (EMOJI.test(line)) report(file, i + 1, "emoji not allowed");
    if (PRIVATE.test(line) && !/<actual-user>|\$USER|example/.test(line)) report(file, i + 1, "private path");
  });
}

function report(file, line, msg) {
  problems++;
  console.log(`${file}:${line}: ${msg}`);
}
if (problems > 0) {
  console.log(`markdown lint: ${problems} problem(s)`);
  process.exit(1);
}
console.log("markdown lint: ok");

// ตรวจว่า JSON / YAML / TOML ทุกไฟล์ใน repo parse ได้ และ policy files ผ่าน schema
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let bad = 0;
let count = 0;
for (const file of walk(process.cwd())) {
  const ext = extname(file);
  try {
    const text = readFileSync(file, "utf8");
    if (ext === ".json") JSON.parse(text);
    else if (ext === ".yaml" || ext === ".yml") YAML.parse(text);
    else if (ext === ".toml") parseToml(text);
    else continue;
    count++;
  } catch (err) {
    bad++;
    console.log(`${file}: ${err.message}`);
  }
}
const { loadMatrix, loadCorePolicy, exampleUserConfig } = await import("../src/core/policy-loader.ts");
loadMatrix();
loadCorePolicy();
exampleUserConfig();
console.log(`data files: ${count} parsed, ${bad} invalid; policy schemas ok`);
process.exit(bad === 0 ? 0 : 1);

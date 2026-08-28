/**
 * Shell command parser สำหรับ policy classification
 *
 * ครอบคลุม: quoting (single/double/backslash), operator ; && || | & newline,
 * redirection (> >> < 2>), command substitution ($(...) `...` ${...}),
 * wrapper (env, command, exec, nice, time, nohup, VAR=value prefix)
 * และ nested shell (sh -c, bash -lc, zsh -c)
 *
 * ข้อจำกัด (ตั้งใจ): ไม่ evaluate glob, brace expansion, heredoc, function, subshell ( ... )
 * คำสั่งที่มี feature เหล่านั้นถูก mark hasSubstitution = true และ policy จะถือว่า target ตรวจไม่ได้
 */

export interface SimpleCommand {
  words: string[];
  /** ไฟล์ที่ถูกเขียนผ่าน redirection > หรือ >> */
  redirectWrites: string[];
  /** ไฟล์ที่ถูกอ่านผ่าน redirection < */
  redirectReads: string[];
  hasSubstitution: boolean;
  /** true เมื่อคำสั่งนี้รับ stdin จาก pipe (ใช้ตรวจ curl | sh) */
  pipedFromPrevious: boolean;
}

const WRAPPERS = new Set(["env", "command", "exec", "nice", "time", "nohup", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Token {
  text: string;
  kind: "word" | "op" | "redirect";
  substitution: boolean;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  let cur = "";
  let inWord = false;
  let substitution = false;

  const flush = (): void => {
    if (inWord) {
      tokens.push({ text: cur, kind: "word", substitution });
      cur = "";
      inWord = false;
      substitution = false;
    }
  };

  while (i < n) {
    const c = input[i];
    if (c === "'") {
      inWord = true;
      i++;
      while (i < n && input[i] !== "'") cur += input[i++];
      i++;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < n) {
          cur += input[i + 1];
          i += 2;
          continue;
        }
        if (input[i] === "$" || input[i] === "`") substitution = true;
        cur += input[i++];
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      inWord = true;
      cur += input[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      inWord = true;
      substitution = true;
      i++;
      while (i < n && input[i] !== "`") cur += input[i++];
      i++;
      continue;
    }
    if (c === "$" && (input[i + 1] === "(" || input[i + 1] === "{")) {
      inWord = true;
      substitution = true;
      const open = input[i + 1];
      const close = open === "(" ? ")" : "}";
      let depth = 0;
      while (i < n) {
        if (input[i] === open) depth++;
        if (input[i] === close) {
          depth--;
          if (depth === 0) {
            cur += input[i++];
            break;
          }
        }
        cur += input[i++];
      }
      continue;
    }
    if (c === "$") {
      // $VAR: จำเป็นต้องขยายทีหลัง; ถือเป็น substitution เว้นแต่เป็น $HOME/$TMPDIR ที่ policy ขยายเอง
      inWord = true;
      let j = i + 1;
      let name = "";
      while (j < n && /[A-Za-z0-9_]/.test(input[j])) name += input[j++];
      if (name !== "HOME" && name !== "TMPDIR" && name !== "PWD") substitution = true;
      cur += input.slice(i, j);
      i = j;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i++;
      continue;
    }
    if (c === "\n" || c === ";") {
      flush();
      tokens.push({ text: ";", kind: "op", substitution: false });
      i++;
      continue;
    }
    if (c === "&" && input[i + 1] === "&") {
      flush();
      tokens.push({ text: "&&", kind: "op", substitution: false });
      i += 2;
      continue;
    }
    if (c === "|" && input[i + 1] === "|") {
      flush();
      tokens.push({ text: "||", kind: "op", substitution: false });
      i += 2;
      continue;
    }
    if (c === "|") {
      flush();
      tokens.push({ text: "|", kind: "op", substitution: false });
      i++;
      continue;
    }
    if (c === "&") {
      flush();
      tokens.push({ text: ";", kind: "op", substitution: false });
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      // subshell: ตรวจไม่ได้แน่นอน ให้ mark substitution และแยก segment
      flush();
      tokens.push({ text: ";", kind: "op", substitution: true });
      i++;
      continue;
    }
    if (c === ">" || c === "<") {
      flush();
      let op = c;
      // 2> , &> , >> , >&
      if (input[i + 1] === ">" || input[i + 1] === "&") op += input[++i];
      if (cur === "" && tokens.length > 0 && tokens[tokens.length - 1].kind === "word" && /^\d$/.test(tokens[tokens.length - 1].text)) {
        // "2>" ถูก tokenize เป็น word "2" ตามด้วย ">"; ลบ fd ออก
        tokens.pop();
      }
      tokens.push({ text: op, kind: "redirect", substitution: false });
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      // comment จนจบบรรทัด
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    inWord = true;
    cur += c;
    i++;
  }
  flush();
  return tokens;
}

function splitSegments(tokens: Token[]): SimpleCommand[] {
  const segments: SimpleCommand[] = [];
  let seg: SimpleCommand = emptySegment(false);
  let pendingRedirect: string | null = null;
  let pipedNext = false;

  const push = (): void => {
    if (seg.words.length > 0 || seg.redirectWrites.length > 0 || seg.redirectReads.length > 0) segments.push(seg);
    seg = emptySegment(pipedNext);
    pipedNext = false;
  };

  for (const t of tokens) {
    if (t.kind === "op") {
      if (t.substitution) seg.hasSubstitution = true;
      const isPipe = t.text === "|";
      push();
      if (isPipe) {
        seg.pipedFromPrevious = true;
      }
      continue;
    }
    if (t.kind === "redirect") {
      pendingRedirect = t.text;
      continue;
    }
    if (pendingRedirect !== null) {
      if (pendingRedirect.startsWith("<")) seg.redirectReads.push(t.text);
      else if (!pendingRedirect.endsWith("&")) seg.redirectWrites.push(t.text);
      pendingRedirect = null;
      if (t.substitution) seg.hasSubstitution = true;
      continue;
    }
    if (t.substitution) seg.hasSubstitution = true;
    seg.words.push(t.text);
  }
  push();
  return segments;
}

function emptySegment(piped: boolean): SimpleCommand {
  return { words: [], redirectWrites: [], redirectReads: [], hasSubstitution: false, pipedFromPrevious: piped };
}

/** ตัด wrapper และ VAR=value prefix ออก คืน words ที่เริ่มด้วย command จริง */
export function stripWrappers(words: string[]): string[] {
  let w = [...words];
  let changed = true;
  while (changed && w.length > 0) {
    changed = false;
    if (ASSIGN.test(w[0])) {
      w.shift();
      changed = true;
      continue;
    }
    if (WRAPPERS.has(w[0])) {
      w.shift();
      // ตัด flag ของ wrapper เช่น env -i, nice -n 10, time -p
      while (w.length > 0 && w[0].startsWith("-")) {
        const flag = w.shift() as string;
        if ((flag === "-n" || flag === "-u" || flag === "-C" || flag === "-S") && w.length > 0) w.shift();
      }
      changed = true;
    }
  }
  return w;
}

const MAX_EXPANSIONS = 32;
const FOR_RE = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+?)\s*(?:;|\n)\s*do\b/g;
const ASSIGN_RE = /(?:^|[;&|\n]\s*)([A-Za-z_][A-Za-z0-9_]*)=("[^"$`]*"|'[^']*'|[^\s;&|$`()]+)(?=\s*(?:[;&|\n]|$))/g;
const LIST_WORD_RE = /"[^"]*"|'[^']*'|\S+/g;

function stripQuotes(w: string): string {
  return (w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'")) ? w.slice(1, -1) : w;
}

/**
 * ขยาย `for VAR in <literal...>; do ... done` และ `VAR=<literal>; ...` ให้ $VAR ในตัวคำสั่งกลายเป็นค่าจริง
 * เพื่อให้ classifier ตัดสินจาก path/argument จริงแทน ASK SHELL_SUBSTITUTION
 * คืน [] เมื่อไม่มี binding ที่ขยายได้ (ค่าในรายการมี $, backtick หรือ subshell) หรือจำนวน combination เกิน MAX_EXPANSIONS
 */
export function expandLiteralBindings(command: string): string[] {
  const bindings: Array<{ name: string; values: string[] }> = [];
  for (const m of command.matchAll(FOR_RE)) {
    const vals = (m[2].match(LIST_WORD_RE) ?? []).filter((w) => w !== "");
    if (vals.length === 0 || vals.some((v) => /[$`(]/.test(v))) continue;
    bindings.push({ name: m[1], values: vals.map(stripQuotes) });
  }
  for (const m of command.matchAll(ASSIGN_RE)) bindings.push({ name: m[1], values: [stripQuotes(m[2])] });
  if (bindings.length === 0) return [];
  let variants = [command];
  for (const b of bindings) {
    const re = new RegExp(`\\$\\{${b.name}\\}|\\$${b.name}(?![A-Za-z0-9_])`, "g");
    const next: string[] = [];
    for (const v of variants) for (const val of b.values) next.push(v.replace(re, () => val));
    variants = [...new Set(next)];
    if (variants.length > MAX_EXPANSIONS) return [];
  }
  return variants.length === 1 && variants[0] === command ? [] : variants;
}

/** คืน command ภายใน $(...) และ `...` ทุกตัว (ระดับนอกสุด) เพื่อ classify แยก */
export function commandSubstitutions(command: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === "'") {
      i++;
      while (i < n && command[i] !== "'") i++;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const start = ++i;
      while (i < n && command[i] !== "`") i++;
      out.push(command.slice(start, i));
      i++;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      let depth = 0;
      const start = i + 2;
      while (i < n) {
        if (command[i] === "(") depth++;
        if (command[i] === ")") {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      out.push(command.slice(start, i));
      i++;
      continue;
    }
    i++;
  }
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** ถ้าเป็น sh -c "..." คืน script ภายใน มิฉะนั้น null */
export function nestedShellScript(words: string[]): string | null {
  if (words.length < 2) return null;
  const base = words[0].split("/").pop() ?? words[0];
  if (!SHELLS.has(base)) return null;
  for (let i = 1; i < words.length; i++) {
    const a = words[i];
    if (a.startsWith("-") && a.includes("c")) {
      return words[i + 1] ?? null;
    }
    if (!a.startsWith("-")) return null;
  }
  return null;
}

/**
 * แยก command เป็น simple command (flatten nested shell แล้ว)
 * segment ที่ได้จาก nested shell จะสืบทอด pipedFromPrevious ของ segment แม่
 */
export function parseCommand(input: string, depth = 0): SimpleCommand[] {
  const segments = splitSegments(tokenize(input));
  const out: SimpleCommand[] = [];
  for (const seg of segments) {
    const words = stripWrappers(seg.words);
    const nested = depth < 4 ? nestedShellScript(words) : null;
    if (nested !== null) {
      const inner = parseCommand(nested, depth + 1);
      for (const s of inner) {
        s.pipedFromPrevious = s.pipedFromPrevious || seg.pipedFromPrevious;
        s.hasSubstitution = s.hasSubstitution || seg.hasSubstitution;
        out.push(s);
      }
      continue;
    }
    out.push({ ...seg, words });
  }
  return out;
}

export function commandName(words: string[]): string {
  if (words.length === 0) return "";
  return (words[0].split("/").pop() ?? words[0]).toLowerCase();
}

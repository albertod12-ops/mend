// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1-10: the command line, output and exit codes,
// safe paths, format detection, three-tier line matching, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits, and the all-or-nothing write
// (a move edit prints one `R old -> new` line in place of its D/A pair).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with one. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  private readonly origExists = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  existsOnDisk(p: string): boolean {
    if (!this.origExists.has(p)) {
      let v = false;
      try {
        statSync(p);
        v = true;
      } catch {
        v = false;
      }
      this.origExists.set(p, v);
    }
    return this.origExists.get(p)!;
  }
  /** True when the path holds a file (or anything at all) in the tree as it stands. */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p)! !== null;
    return this.existsOnDisk(p);
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  if (tier === 1) return t;
  return t.replace(/^[ \t]+/, '');
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at least once, with its positions, or null. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const tier of tiers(strict)) {
    const occ = occurrences(lines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of N: `ctx >= 0` is a context line (O's line ctx), `-1` an added line. */
interface NewLine {
  text: string;
  ctx: number;
}

/** The lines N writes for a match at `at`: context lines as the file has them,
 * other lines re-indented at tier 2, as they are at tiers 0 and 1. */
function buildNew(fileLines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  return n.map((e) => {
    if (e.ctx >= 0) return fileLines[at + e.ctx]!;
    if (tier === 2 && o.length > 0) {
      const f = leadingWs(fileLines[at]!);
      const p = leadingWs(o[0]!);
      const t = e.text;
      if (t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return e.text;
  });
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (kept from the kit starter, with exists() for paths
// that hold a directory instead of a file)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (!tree.exists(p)) throw new Fail('missing', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: string; // ' ' context, '-' old, '+' new, '\\' no-newline marker
  text: string;
}

interface Hunk {
  a: number; // old start line, 1-based (0: before the first line)
  body: BodyLine[];
}

interface Section {
  oldPath: string | null; // null: /dev/null
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to
 * the first tab, with surrounding spaces removed; `/dev/null` means no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (oldPath: string | null, newPath: string | null): Section => {
    const s: Section = { oldPath, newPath, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  // Header state collected per section, resolved when the section is complete.
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renameOld: string | null | undefined;
  let renameNew: string | null | undefined;
  let gitOld: string | null | undefined;
  let gitNew: string | null | undefined;

  const startSection = (oldP: string | null | undefined, newP: string | null | undefined): void => {
    cur = newSection(oldP ?? null, newP ?? null);
    inHeader = true;
    pairOld = undefined;
    pairNew = undefined;
    renameOld = undefined;
    renameNew = undefined;
    gitOld = oldP;
    gitNew = newP;
  };
  const finishSection = (): void => {
    if (cur === null) return;
    if (pairOld !== undefined) cur.oldPath = pairOld;
    else if (renameOld !== undefined) cur.oldPath = renameOld;
    else if (gitOld !== undefined) cur.oldPath = gitOld;
    if (pairNew !== undefined) cur.newPath = pairNew;
    else if (renameNew !== undefined) cur.newPath = renameNew;
    else if (gitNew !== undefined) cur.newPath = gitNew;
  };

  const parseHunk = (i: number): { hunk: Hunk; next: number } => {
    const m = HUNK_RE.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const body: BodyLine[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      // A `--- ` line followed by a `+++ ` line ends the body (SPEC.md 6),
      // even though it starts with `-` like an old line.
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith(' ')) body.push({ kind: ' ', text: l.slice(1) });
      else if (l.startsWith('-')) body.push({ kind: '-', text: l.slice(1) });
      else if (l.startsWith('+')) body.push({ kind: '+', text: l.slice(1) });
      else if (l.startsWith('\\')) body.push({ kind: '\\', text: l });
      else if (l === '') body.push({ kind: ' ', text: '' });
      else break;
      j += 1;
    }
    while (body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.kind === ' ' && last.text === '') body.pop();
      else break;
    }
    return { hunk: { a: Number(m[1]), body }, next: j };
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        finishSection();
        startSection(undefined, undefined);
      }
      pairOld = headerPath(line);
      pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('@@')) {
        const { hunk, next } = parseHunk(i);
        cur.hunks.push(hunk);
        inHeader = false;
        i = next;
        continue;
      }
      if (line.startsWith('rename from ')) renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    if (cur !== null && line.startsWith('@@')) {
      const { hunk, next } = parseHunk(i);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (cur === null && line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  finishSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.body.length; k++) {
    if (h.body[k]!.kind === ' ' || h.body[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  return h.body[last + 1]?.kind === '\\';
}

/** Split a hunk body into O (context + `-` lines) and N (context + `+` lines). */
function hunkON(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ text: b.text, ctx: -1 });
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file's text. Throws Fail(no-match). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    const noEol = hunkNoEol(h);
    if (o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const ins = n.map((e) => e.text);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...ins);
      if (atEnd) f.final = !noEol;
      d += n.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let at = found.occ[0]!;
    let best = Math.abs(at - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        at = p;
        best = dist;
      }
    }
    const newLines = buildNew(f.lines, at, o, n, found.tier);
    const touchesEnd = at + o.length === f.lines.length;
    f.lines.splice(at, o.length, ...newLines);
    if (touchesEnd) f.final = !noEol;
    d += n.length - o.length;
  }
  return joinFile(f);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    // Every path the edit names is checked for safety before anything else.
    if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    if (sec.isCreate || sec.oldPath === null) {
      const np = sec.newPath;
      if (np === null) throw new Fail('unsafe', '');
      if (tree.exists(np)) throw new Fail('exists', np);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.kind === '+') {
            plus.push(h.body[k]!.text);
            noEol = h.body[k + 1]?.kind === '\\';
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (sec.isDelete || sec.newPath === null) {
      const op = sec.oldPath!;
      if (!tree.exists(op)) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (sec.oldPath !== sec.newPath) {
      const op = sec.oldPath!;
      const np = sec.newPath!;
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.exists(np)) throw new Fail('exists', np);
      const result = applyHunks(before, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, result);
      tree.moves.push({ old: op, new: np });
      return;
    }
    const p = sec.oldPath!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const newL = buildNew(f.lines, at, oldLines, n, found.tier);
    f.lines.splice(at, oldLines.length, ...newL);
    tree.now.set(path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

const SECTION_START = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (SECTION_START(l)) break;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (blank(l)) {
          i += 1;
          continue;
        }
        if (SECTION_START(l)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (SECTION_START(l)) break;
        // A blank line with no chunk open, after at least one chunk (i.e.
        // after `*** End of File` closed it), is a blank line at the end of
        // the section (SPEC.md 8: not part of it) — skip it. A blank line
        // before the first chunk is that chunk's first body line instead
        // (an empty context line), and a blank line inside an open chunk
        // is one of its body lines, so neither is skipped here.
        if (l === '' && cur === null && chunks.length > 0) {
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          i += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0) {
          const b = lc.body[lc.body.length - 1]!;
          if (b.kind === ' ' && b.text === '') lc.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.exists(path)) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (!tree.exists(path)) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let at = -1;
        for (const tier of tiers(strict)) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (normLine(f.lines[k]!, tier) === normLine(ch.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = hunkON({ a: 0, body: ch.body });
      if (o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = n.map((e) => e.text);
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      let found: { tier: number; at: number } | null = null;
      for (const tier of tiers(strict)) {
        const occ = occurrences(f.lines, o, tier).filter(
          (p) => p >= cursor && (!ch.eof || p + o.length === f.lines.length),
        );
        if (occ.length > 0) {
          found = { tier, at: occ[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const newL = buildNew(f.lines, found.at, o, n, found.tier);
      f.lines.splice(found.at, o.length, ...newL);
      cursor = found.at + newL.length;
    }
    const result = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, result);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output, order and atomicity
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per changed path in byte order; a move prints one
  // `R old -> new` line (sorted by new) in place of its D and A lines.
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.now.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      movedOld.add(m.old);
      movedNew.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null && movedOld.has(p)) continue;
    if (was === null && movedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

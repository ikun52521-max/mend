// mend: one patch tool for every AI edit format.
//
// Applies an edit a model wrote — a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls
// as JSON — to the tree under the working directory, following SPEC.md.
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Thrown to end with exit 2 and one line on stdout. */
class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** Thrown by one edit that fails; the run reports it and keeps going. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const FORMATS: string[] = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** SPEC section 3: a path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or .. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** One file's text as lines: its line break, its lines, whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function readText(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function writeText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripEdgeWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/**
 * The tree as the edits leave it. `current` holds what an edit changed
 * (null: deleted); anything else is read from disk and cached.
 */
class Tree {
  private disk = new Map<string, string | null>();
  private current = new Map<string, string | null>();
  /** Successful moves, in order, for the R lines of the output. */
  moves: Array<{ from: string; to: string }> = [];

  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p) as string | null;
  }

  get(p: string): string | null {
    if (this.current.has(p)) return this.current.get(p) as string | null;
    return this.before(p);
  }

  set(p: string, v: string | null): void {
    this.current.set(p, v);
  }

  changed(): string[] {
    return [...this.current.keys()];
  }

  snapshot(): { current: Map<string, string | null>; moves: Array<{ from: string; to: string }> } {
    return { current: new Map(this.current), moves: this.moves.slice() };
  }

  restore(s: { current: Map<string, string | null>; moves: Array<{ from: string; to: string }> }): void {
    this.current = new Map(s.current);
    this.moves = s.moves.slice();
  }
}

/** One edit: a function of the tree that throws EditFail when it fails. */
type Edit = (tree: Tree) => void;

/** Does one file line match one old line at a tier? (SPEC section 5.) */
function lineMatches(fileLine: string, oldLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oldLine;
  if (tier === 1) return stripTrailingWs(fileLine) === stripTrailingWs(oldLine);
  return stripEdgeWs(fileLine) === stripEdgeWs(oldLine);
}

/** Every position at or after `from` where `old` occurs in `lines` at `tier`. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!lineMatches(lines[i + j] as string, old[j] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs at or after `from`, with its positions. */
function firstTier(lines: string[], old: string[], from: number): { tier: number; at: number[] } | null {
  for (let tier = 0; tier <= maxTier(); tier++) {
    const at = occurrences(lines, old, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of the old side (O) or the new side (N) of a hunk, chunk or block. */
interface SideLine {
  /** The line's text, without its marker. */
  text: string;
  /** True when the line is in both O and N (a context line). */
  context: boolean;
  /** For a context line of N: its index in O. */
  oldIndex: number;
}

/**
 * The lines N writes when it replaces O at position `at` of `lines` at `tier`.
 * A context line is written as the file's own matched line; at tier 2 every
 * other line is re-indented from O's first line to the file's first matched line.
 */
function replacementLines(lines: string[], at: number, oldSide: SideLine[], newSide: SideLine[], tier: number): string[] {
  const out: string[] = [];
  const firstFile = tier === 2 ? leadingWs(lines[at] as string) : '';
  const firstOld = tier === 2 ? leadingWs(oldSide[0]?.text ?? '') : '';
  for (const item of newSide) {
    if (item.context) {
      out.push(lines[at + item.oldIndex] as string);
      continue;
    }
    const t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(firstOld)) {
      out.push(firstFile + t.slice(firstOld.length));
    } else {
      out.push(t);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const readExisting = (tree: Tree): string => {
    if (!safePath(p)) throw new EditFail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const fold = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = fold(before);
      const old = fold(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + fold(newStr) + text.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const f = readText(before);
      if (line < 0 || line > f.lines.length) throw new EditFail('no-match', p);
      f.lines.splice(line, 0, ...added);
      tree.set(p, writeText(f));
    };
  }

  return null;
}

/** The edits of a JSON patch: one array, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
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

/* ------------------------------------------------------------------ */
/* Format detection (SPEC section 4)                                   */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** A of @@ -A[,B] +C[,D] @@. */
  start: number;
  /** The hunk's body lines, trailing empty lines removed. */
  body: string[];
  oldSide: SideLine[];
  newSide: SideLine[];
  /** A \ line follows the hunk's last context or + line. */
  noEol: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** A path from a `--- ` or `+++ ` header line; /dev/null is no path. */
function uniHeaderPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function buildHunk(header: string, body: string[]): Hunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/.exec(header);
  const start = Number(m?.[1] ?? 0);
  const oldSide: SideLine[] = [];
  const newSide: SideLine[] = [];
  let lastCtxPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k] as string;
    if (l === '' || l[0] === ' ' || l[0] === '+') lastCtxPlus = k;
  }
  const noEol =
    lastCtxPlus >= 0 &&
    body[lastCtxPlus + 1] !== undefined &&
    (body[lastCtxPlus + 1] as string).startsWith('\\');
  for (const l of body) {
    if (l === '') {
      const idx = oldSide.length;
      oldSide.push({ text: '', context: true, oldIndex: idx });
      newSide.push({ text: '', context: true, oldIndex: idx });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      const idx = oldSide.length;
      oldSide.push({ text: t, context: true, oldIndex: idx });
      newSide.push({ text: t, context: true, oldIndex: idx });
    } else if (l[0] === '-') {
      oldSide.push({ text: l.slice(1), context: false, oldIndex: -1 });
    } else if (l[0] === '+') {
      newSide.push({ text: l.slice(1), context: false, oldIndex: -1 });
    }
    // A \ line refers to the body line before it and adds no line of its own.
  }
  return { start, body, oldSide, newSide, noEol };
}

/** Apply one section's hunks, in order, to a file's text. */
function applyHunks(content: string, hunks: Hunk[], failPath: string): string {
  let f = readText(content);
  let d = 0;
  for (const h of hunks) {
    const oldTexts = h.oldSide.map((x) => x.text);
    if (oldTexts.length === 0) {
      const at = Math.min(Math.max(h.start + d, 0), f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...h.newSide.map((x) => x.text));
      if (atEnd) f.finalBreak = !h.noEol;
      d += h.newSide.length;
      continue;
    }
    const found = firstTier(f.lines, oldTexts, 0);
    if (found === null) throw new EditFail('no-match', failPath);
    const target = h.start - 1 + d;
    let best = found.at[0] as number;
    let bestDist = Math.abs(best - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const touchesEnd = best + oldTexts.length === f.lines.length;
    const repl = replacementLines(f.lines, best, h.oldSide, h.newSide, found.tier);
    f.lines = [...f.lines.slice(0, best), ...repl, ...f.lines.slice(best + oldTexts.length)];
    if (touchesEnd) f.finalBreak = !h.noEol;
    d += h.newSide.length - oldTexts.length;
  }
  return writeText(f);
}

function uniSectionEdit(sec: UniSection): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safePath(oldP)) throw new EditFail('unsafe', oldP);
    if (newP !== null && !safePath(newP)) throw new EditFail('unsafe', newP);
    if (sec.create || oldP === null) {
      const to = newP;
      if (to === null) throw new EditFail('unsafe', '/dev/null');
      if (tree.get(to) !== null) throw new EditFail('exists', to);
      const plus: string[] = [];
      let noEol = false;
      let lastPlus: { h: number; k: number } | null = null;
      sec.hunks.forEach((h, hi) => {
        h.body.forEach((l, k) => {
          if (l.startsWith('+')) lastPlus = { h: hi, k };
        });
        for (const item of h.newSide) if (!item.context) plus.push(item.text);
      });
      if (lastPlus !== null) {
        const h = sec.hunks[lastPlus.h] as Hunk;
        const next = h.body[lastPlus.k + 1];
        noEol = next !== undefined && next.startsWith('\\');
      }
      tree.set(to, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (sec.remove || newP === null) {
      const from = oldP;
      if (from === null) throw new EditFail('unsafe', '/dev/null');
      if (tree.get(from) === null) throw new EditFail('missing', from);
      tree.set(from, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP) === null) throw new EditFail('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFail('exists', newP);
      const out = applyHunks(tree.get(oldP) as string, sec.hunks, oldP);
      tree.set(newP, out);
      tree.set(oldP, null);
      tree.moves.push({ from: oldP, to: newP });
      return;
    }
    if (tree.get(oldP) === null) throw new EditFail('missing', oldP);
    tree.set(oldP, applyHunks(tree.get(oldP) as string, sec.hunks, oldP));
  };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const fresh = (): UniSection => {
    const s: UniSection = { oldPath: null, newPath: null, create: false, remove: false, hasPair: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < n) {
    const l = lines[i] as string;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.oldPath = m[1] as string;
      cur.newPath = m[2] as string;
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.oldPath = uniHeaderPath(l);
        cur.newPath = uniHeaderPath(lines[i + 1] as string);
        cur.hasPair = true;
      } else {
        cur = fresh();
        cur.oldPath = uniHeaderPath(l);
        cur.newPath = uniHeaderPath(lines[i + 1] as string);
        cur.hasPair = true;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const bl = lines[j] as string;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(l, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ') && !cur.hasPair) cur.oldPath = l.slice(12).trim();
      else if (l.startsWith('rename to ') && !cur.hasPair) cur.newPath = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.remove = true;
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: and any other header line are ignored.
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => uniSectionEdit(s));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    const f = readText(before);
    const found = firstTier(f.lines, oldLines, 0);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const at = found.at[0] as number;
    const oldSide: SideLine[] = oldLines.map((t) => ({ text: t, context: false, oldIndex: -1 }));
    const newSide: SideLine[] = newLines.map((t) => ({ text: t, context: false, oldIndex: -1 }));
    const repl = replacementLines(f.lines, at, oldSide, newSide, found.tier);
    f.lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)];
    tree.set(path, writeText(f));
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = (lines[j] as string).trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = (lines[j] as string).trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = (lines[j] as string).trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** The @@ anchor, or null when the chunk has none. */
  anchor: string | null;
  /** The chunk's body lines (markers stripped by the caller into sides). */
  body: string[];
  /** True when a *** End of File line ended this chunk. */
  eof: boolean;
}

function chunkSides(chunk: V4aChunk): { oldSide: SideLine[]; newSide: SideLine[] } {
  const oldSide: SideLine[] = [];
  const newSide: SideLine[] = [];
  for (const l of chunk.body) {
    if (l === '') {
      const idx = oldSide.length;
      oldSide.push({ text: '', context: true, oldIndex: idx });
      newSide.push({ text: '', context: true, oldIndex: idx });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      const idx = oldSide.length;
      oldSide.push({ text: t, context: true, oldIndex: idx });
      newSide.push({ text: t, context: true, oldIndex: idx });
    } else if (l[0] === '-') {
      oldSide.push({ text: l.slice(1), context: false, oldIndex: -1 });
    } else if (l[0] === '+') {
      newSide.push({ text: l.slice(1), context: false, oldIndex: -1 });
    }
  }
  return { oldSide, newSide };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const f = readText(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let foundAt = -1;
        for (let tier = 0; tier <= maxTier() && foundAt < 0; tier++) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineMatches(f.lines[k] as string, chunk.anchor, tier)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt < 0) throw new EditFail('no-match', path);
        cursor = foundAt + 1;
      }
      const { oldSide, newSide } = chunkSides(chunk);
      const oldTexts = oldSide.map((x) => x.text);
      if (oldTexts.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...newSide.map((x) => x.text));
        cursor = at + newSide.length;
        continue;
      }
      if (chunk.eof) {
        const at = f.lines.length - oldTexts.length;
        if (at < cursor) throw new EditFail('no-match', path);
        const found = firstTier(f.lines, oldTexts, at);
        if (found === null || found.at[0] !== at) throw new EditFail('no-match', path);
        const repl = replacementLines(f.lines, at, oldSide, newSide, found.tier);
        f.lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldTexts.length)];
        cursor = at + repl.length;
        continue;
      }
      const found = firstTier(f.lines, oldTexts, cursor);
      if (found === null) throw new EditFail('no-match', path);
      const at = found.at[0] as number;
      const repl = replacementLines(f.lines, at, oldSide, newSide, found.tier);
      f.lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldTexts.length)];
      cursor = at + repl.length;
    }
    const out = writeText(f);
    if (moveTo !== null) {
      tree.set(moveTo, out);
      tree.set(path, null);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.set(path, out);
    }
  };
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i] as string;
    if (isBlank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'delete' : 'update';
      const path = l.slice(kind === 'add' ? 14 : 17).trim();
      // Collect the section's lines, then drop the blank ones at its end.
      let j = i + 1;
      const raw: string[] = [];
      while (j < last && !isSectionStart(lines[j] as string)) {
        raw.push(lines[j] as string);
        j++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1] as string)) raw.pop();
      if (kind === 'add') {
        const made: string[] = [];
        for (let k = 0; k < raw.length; k++) {
          const r = raw[k] as string;
          if (r === '') made.push('');
          else if (r.startsWith('+')) made.push(r.slice(1));
          else throw new Exit2(`error: parse ${i + 2 + k}`);
        }
        const text = made;
        edits.push((tree) => {
          if (!safePath(path)) throw new EditFail('unsafe', path);
          if (tree.get(path) !== null) throw new EditFail('exists', path);
          tree.set(path, text.length === 0 ? '' : text.join('\n') + '\n');
        });
      } else if (kind === 'delete') {
        for (let k = 0; k < raw.length; k++) {
          throw new Exit2(`error: parse ${i + 2 + k}`);
        }
        edits.push((tree) => {
          if (!safePath(path)) throw new EditFail('unsafe', path);
          if (tree.get(path) === null) throw new EditFail('missing', path);
          tree.set(path, null);
        });
      } else {
        let moveTo: string | null = null;
        let bodyStart = 0;
        if ((raw[0] ?? '').startsWith('*** Move to: ')) {
          moveTo = (raw[0] as string).slice(13).trim();
          bodyStart = 1;
        }
        const chunks: V4aChunk[] = [];
        let cur: V4aChunk | null = null;
        for (let k = bodyStart; k < raw.length; k++) {
          const r = raw[k] as string;
          if (r.startsWith('@@')) {
            if (cur !== null) chunks.push(cur);
            const anchor = r.slice(2).trim();
            cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          } else if (r === '*** End of File') {
            if (cur === null) throw new Exit2(`error: parse ${i + 2 + k}`);
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          } else if (r === '' || r[0] === ' ' || r[0] === '-' || r[0] === '+') {
            if (cur === null) {
              if (chunks.length > 0) throw new Exit2(`error: parse ${i + 2 + k}`);
              cur = { anchor: null, body: [], eof: false };
            }
            cur.body.push(r);
          } else {
            throw new Exit2(`error: parse ${i + 2 + k}`);
          }
        }
        if (cur !== null) chunks.push(cur);
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
        edits.push(v4aUpdateEdit(path, moveTo, chunks));
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running (SPEC sections 1, 2 and 10)                                 */
/* ------------------------------------------------------------------ */

/** With --strict only tier 0 is tried (SPEC section 5). */
let strictOnly = false;

function maxTier(): number {
  return strictOnly ? 0 : 2;
}

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
  strictOnly = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedAway = new Set<string>();
  const movedTo = new Set<string>();
  for (const m of tree.moves) {
    if (
      tree.before(m.from) !== null &&
      tree.get(m.from) === null &&
      tree.before(m.to) === null &&
      tree.get(m.to) !== null
    ) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      movedAway.add(m.from);
      movedTo.add(m.to);
    }
  }
  for (const p of tree.changed()) {
    const was = tree.before(p);
    const now = tree.get(p);
    if (was === now) continue;
    if (movedAway.has(p) || movedTo.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of tree.changed()) {
      const was = tree.before(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
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

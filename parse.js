// parse.js — a fast Markdown-to-HTML renderer written from scratch.
//
// parse(markdown) returns the HTML for a document under the CommonMark
// 0.31.2 + GFM dialect: ATX and setext headings, fenced and indented code,
// block quotes, lists (including task lists), thematic breaks, HTML blocks,
// link reference definitions and GFM tables at block level; code spans,
// emphasis, strikethrough, links, images, autolinks (including the GFM
// extended ones) and raw HTML inline.
//
// The implementation is a line-oriented container parser for blocks plus a
// delimiter-stack scanner for inline content. It favours direct character
// scanning over regular expressions in the hot paths.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CC_TAB = 9;
const CC_LF = 10;
const CC_SPACE = 32;

function isBlank(s, from, to) {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) return false;
  }
  return true;
}

// Escape text-node characters: &, <, > and both quote characters (the
// reference renderer escapes quotes in text as &quot; and &#39;). `&` that
// begins an entity-shaped reference never reaches this function: the
// scanner emits such references as raw nodes.
function escapeText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (start < i) out += s.slice(start, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape the content of a code block or code span: &, <, > and ".
function escapeCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (start < i) out += s.slice(start, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Length of the entity-shaped sequence starting at s[i] === '&', or 0 when
// the '&' does not begin one. Named references are a letter followed by
// letters/digits; numeric references are capped at 7 decimal or 6 hex
// digits — longer digit runs are not references at all.
function entityShapeLen(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return 0;
  if (s[j] === '#') {
    j++;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      const st = j;
      while (j < n && j - st < 6 && /[0-9a-fA-F]/.test(s[j])) j++;
      return j > st && s[j] === ';' ? j - i + 1 : 0;
    }
    const st = j;
    while (j < n && j - st < 7 && s[j] >= '0' && s[j] <= '9') j++;
    return j > st && s[j] === ';' ? j - i + 1 : 0;
  }
  if (!/[A-Za-z]/.test(s[j])) return 0;
  j++;
  while (j < n && /[A-Za-z0-9]/.test(s[j])) j++;
  return s[j] === ';' ? j - i + 1 : 0;
}

// Escape a value placed inside a double-quoted attribute: &, <, > and both
// quotes are escaped, except that an '&' beginning an entity-shaped
// sequence passes through as written.
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const len = entityShapeLen(s, i);
      if (len > 0) { i += len - 1; continue; }
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (start < i) out += s.slice(start, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------------------------------------------------------------------------
// Character references
// ---------------------------------------------------------------------------

// In text, every named reference passes through un-decoded (defined or
// not). Numeric references decode arithmetically, but digit runs longer
// than 7 decimal or 6 hex digits are not references at all.
const ENTITY_RE = /^&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[A-Za-z][A-Za-z0-9]*);/;

// If s starting at i (which holds '&') is a character reference, return
// [decodedString, nextIndex]; the decoded string may be the sentinel
// RAW_ENTITY when a named reference should pass through un-decoded.
// Otherwise return null.
const RAW_ENTITY = '\u0001';
function matchEntity(s, i) {
  const m = ENTITY_RE.exec(s.slice(i, i + 34));
  if (!m) return null;
  const body = m[1];
  if (body.charCodeAt(0) === 35) {
    let cp;
    if (body.length > 1 && (body[1] === 'x' || body[1] === 'X')) {
      if (body.length - 2 > 6) return null;
      cp = parseInt(body.slice(2), 16);
    } else {
      if (body.length - 1 > 7) return null;
      cp = parseInt(body.slice(1), 10);
    }
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return [String.fromCodePoint(cp), i + m[0].length];
  }
  return [RAW_ENTITY, i + m[0].length];
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Normalise a link label: trim, collapse internal whitespace, fold case.
function normaliseLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Try to read one link reference definition at the start of text (the text
// of a paragraph, whose lines are joined with '\n'). On success return
// {label, href, title, length}; on failure return null.
function scanLinkDef(text) {
  const n = text.length;
  let i = 0;
  // Up to three leading spaces (the paragraph text is already de-indented,
  // so this is only a formality), then '['.
  while (i < n && text[i] === ' ' && i < 3) i++;
  if (text[i] !== '[') return null;
  // Label: up to the matching unescaped ']', no unescaped '[' inside.
  let j = i + 1;
  let labelEnd = -1;
  while (j < n) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') { labelEnd = j; break; }
    j++;
  }
  if (labelEnd === -1) return null;
  const label = text.slice(i + 1, labelEnd);
  if (label.length === 0 || label.length > 999 || label.trim() === '') return null;
  j = labelEnd + 1;
  if (text[j] !== ':') return null;
  j++;
  // Optional whitespace, including at most one line ending.
  j = skipDefSpace(text, j);
  if (j === -1) return null;
  // Destination: <...> or a run of non-space characters with balanced parens.
  let href;
  if (text[j] === '<') {
    let k = j + 1;
    while (k < n && text[k] !== '>' && text[k] !== '\n') {
      if (text[k] === '\\') k++;
      k++;
    }
    if (text[k] !== '>') return null;
    href = text.slice(j + 1, k);
    j = k + 1;
  } else {
    let k = j;
    let depth = 0;
    while (k < n) {
      const ch = text[k];
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (ch === '\\') { k += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (ch < ' ') return null;
      k++;
    }
    if (k === j || depth !== 0) return null;
    href = text.slice(j, k);
    j = k;
  }
  href = unescapePunct(href);
  // Optional title, separated by whitespace (at most one line ending in it),
  // then only whitespace to the end of the definition's last line.
  let title = null;
  let k = j;
  let sawNewline = false;
  while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) {
    if (text[k] === '\n') { if (sawNewline) break; sawNewline = true; }
    k++;
  }
  if (k < n && k > j) {
    const q = text[k];
    if (q === '"' || q === "'" || q === '(') {
      const close = q === '(' ? ')' : q;
      let e = k + 1;
      while (e < n && text[e] !== close) {
        if (text[e] === '\\') e++;
        e++;
      }
      if (e < n) {
        title = unescapePunct(text.slice(k + 1, e));
        // After the title only spaces/tabs may precede the line end.
        let a = e + 1;
        while (a < n && (text[a] === ' ' || text[a] === '\t')) a++;
        if (a === n || text[a] === '\n') {
          return { label, href, title, length: a };
        }
      }
      // Malformed title: fall through and try the title-less ending. 
    }
  }
  // No title: the definition ends at the end of the destination's line.
  let a = j;
  while (a < n && (text[a] === ' ' || text[a] === '\t')) a++;
  if (a === n || text[a] === '\n') {
    return { label, href, title, length: a };
  }
  return null;
}

function skipDefSpace(text, j) {
  const n = text.length;
  let newlines = 0;
  while (j < n) {
    const ch = text[j];
    if (ch === ' ' || ch === '\t') { j++; continue; }
    if (ch === '\n') { newlines++; if (newlines > 1) return -1; j++; continue; }
    break;
  }
  return j;
}

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function unescapePunct(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.includes(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Consume every link reference definition at the head of a paragraph's
// text, recording them in defs (first definition of a label wins).
// Returns the remaining text.
function extractDefs(text, defs) {
  let rest = text;
  for (;;) {
    const def = scanLinkDef(rest);
    if (!def) return rest;
    const key = normaliseLabel(def.label);
    if (key && !defs.has(key)) {
      defs.set(key, { href: def.href, title: def.title });
    }
    rest = rest.slice(def.length);
    if (rest.startsWith('\n')) rest = rest.slice(1);
    if (rest.trim() === '') return '';
  }
}

// ---------------------------------------------------------------------------
// Block parsing
//
// A line-oriented container parser. Each input line is matched against the
// stack of open blocks (block quotes and list items ask for their prefix to
// be present), then new blocks may start, then the line feeds the open leaf
// block. Blocks are plain objects: { t, children, parent, ... }.
// ---------------------------------------------------------------------------

function newBlock(t) {
  return { t, children: [], parent: null, lastLineBlank: false, startLine: 0 };
}

function appendChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  // Content inside a list's current item means a pending blank line was
  // internal to that item, not an item separator.
  for (let a = parent; a; a = a.parent) {
    if (a.t === 'item' && a.parent && a.parent.t === 'list') a.parent.blankPending = false;
  }
  return child;
}

// A cursor over one line, tracking character index and column so tabs can
// be consumed by columns (a tab advances to the next multiple of 4).
function lineCursor(s) {
  return { s, i: 0, col: 0, tabRest: 0 };
}
function curPeek(cur) {
  if (cur.tabRest > 0) return ' ';
  return cur.i < cur.s.length ? cur.s[cur.i] : '';
}
function curDone(cur) {
  return cur.tabRest === 0 && cur.i >= cur.s.length;
}
function curBlank(cur) {
  // A partially consumed tab contributes only spaces, so the remainder is
  // blank iff the unconsumed characters are all spaces/tabs.
  for (let j = cur.i; j < cur.s.length; j++) {
    const c = cur.s.charCodeAt(j);
    if (c !== CC_SPACE && c !== CC_TAB) return false;
  }
  return true;
}
// Consume one character if it equals ch (a tab counts as its first column
// only when tabRest semantics allow; used for single chars like '>').
function curTake(cur, ch) {
  if (cur.tabRest > 0) {
    if (ch === ' ') { cur.tabRest--; cur.col++; return true; }
    return false;
  }
  if (cur.s[cur.i] === ch) {
    if (ch === '\t') cur.col += 4 - (cur.col % 4);
    else cur.col++;
    cur.i++;
    return true;
  }
  return false;
}
// Try to consume n columns of indentation. Returns true on success; on
// failure the cursor is left wherever the attempt stopped.
function curIndent(cur, n) {
  while (n > 0) {
    if (cur.tabRest > 0) {
      const take = Math.min(n, cur.tabRest);
      cur.tabRest -= take;
      cur.col += take;
      n -= take;
      continue;
    }
    const ch = cur.s[cur.i];
    if (ch === ' ') { cur.i++; cur.col++; n--; }
    else if (ch === '\t') {
      const w = 4 - (cur.col % 4);
      if (w <= n) { cur.i++; cur.col += w; n -= w; }
      else { cur.i++; cur.tabRest = w - n; cur.col += n; n = 0; }
    } else return false;
  }
  return true;
}
// Consume up to n columns of indentation; returns columns consumed.
function curSomeIndent(cur, n) {
  let done = 0;
  while (done < n) {
    if (cur.tabRest > 0) { cur.tabRest--; cur.col++; done++; continue; }
    const ch = cur.s[cur.i];
    if (ch === ' ') { cur.i++; cur.col++; done++; }
    else if (ch === '\t') {
      const w = 4 - (cur.col % 4);
      if (w <= n - done) { cur.i++; cur.col += w; done += w; }
      else { cur.i++; cur.tabRest = w - (n - done); cur.col += n - done; done = n; }
    } else break;
  }
  return done;
}
// Columns of indentation remaining at the cursor (spaces and tabs).
function curIndentWidth(cur) {
  let cols = cur.tabRest;
  let col = cur.col + cur.tabRest;
  for (let j = cur.i; j < cur.s.length; j++) {
    const ch = cur.s[j];
    if (ch === ' ') { cols++; col++; }
    else if (ch === '\t') { const w = 4 - (col % 4); cols += w; col += w; }
    else break;
  }
  return cols;
}
// The rest of the line as a string, materialising a partially consumed tab
// as the spaces it stands for.
function curRest(cur) {
  if (cur.tabRest > 0) return ' '.repeat(cur.tabRest) + cur.s.slice(cur.i);
  return cur.s.slice(cur.i);
}
// Number of leading space/tab characters in a string.
function countWsChars(str) {
  let k = 0;
  while (k < str.length && (str[k] === ' ' || str[k] === '\t')) k++;
  return k;
}

// A fenced code block's content line as the reference tokenizer
// computes it: for backtick fences, strip the smaller of the line's own
// leading-whitespace length and the opening fence line's whitespace
// length, both counted in characters (a tab counts once). Tilde fences
// get no compensation at all.
function fenceLineText(line, leaf) {
  if (leaf.fenceChar !== '`' || !leaf.indentChars) return line;
  const m = /^\s+/.exec(line);
  if (!m) return line;
  return line.slice(Math.min(m[0].length, leaf.indentChars));
}

// Remove exactly n columns from the front of a raw line (for indented code
// and fenced code content), returning the remaining string.
function stripColumns(s, n) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    const ch = s[i];
    if (ch === ' ') { i++; col++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { i++; col += w; }
      else return ' '.repeat(col + w - n) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// If the line remainder starts an HTML block, return {type, endTag} with
// type 1..7 (per the block grammar), else null. endTag is set for type 1.
function htmlBlockStart(rest, inParagraph) {
  if (rest.charCodeAt(0) !== 60) return null; // '<'
  const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  const lower = s => s.toLowerCase();
  if (rest.startsWith('<!--')) return { type: 2 };
  if (rest.startsWith('<?')) return { type: 3 };
  if (/^<![A-Z]/.test(rest)) return { type: 4 };
  if (rest.startsWith('<![CDATA[')) return { type: 5 };
  if (m) {
    const tag = lower(m[1]);
    if (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') {
      const after = rest[m[0].length];
      if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '>' || (after === '/' && rest[m[0].length + 1] === '>')) {
        return { type: 1, endTag: '</' + tag };
      }
    }
    if (BLOCK_TAGS.has(tag)) {
      const after = rest[m[0].length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' || (after === '/' && rest[m[0].length + 1] === '>')) {
        return { type: 6 };
      }
    }
  }
  const close = /^<\/([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (close) {
    const tag = lower(close[1]);
    if (BLOCK_TAGS.has(tag)) {
      const after = rest[close[0].length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' || (after === '/' && rest[close[0].length + 1] === '>')) {
        return { type: 6 };
      }
    }
  }
  if (inParagraph) return null;
  // Type 7: a complete open or closing tag and nothing else on the line.
  if (isCompleteTagLine(rest)) return { type: 7 };
  return null;
}

const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTR = '(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"\'`=<>]+|\'[^\'\n]*\'|"[^"\n]*"))?)';
const OPEN_TAG_RE = new RegExp('^<' + TAG_NAME + ATTR + '*\\s*/?>');
const CLOSE_TAG_RE = new RegExp('^</' + TAG_NAME + '\\s*>');
function isCompleteTagLine(rest) {
  const m = OPEN_TAG_RE.exec(rest) || CLOSE_TAG_RE.exec(rest);
  if (!m) return false;
  return /^[ \t]*$/.test(rest.slice(m[0].length));
}

// Split a table row into trimmed cell strings. Pipes inside code spans do
// not split, and \| is an escaped pipe.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '\\') { cur += '\\\\'; i++; continue; }
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function isDelimiterRow(line) {
  const t = line.trim();
  if (!t.includes('-')) return null;
  const cells = splitRow(t);
  const aligns = [];
  for (const cell of cells) {
    const m = /^:?-+:?$/.exec(cell.replace(/ /g, ''));
    if (!m) return null;
    const c = cell.replace(/ /g, '');
    aligns.push(c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null);
  }
  return aligns;
}

// The text of the line remaining at the cursor after removing n more
// columns of indentation (used for code block content lines).
function restAfterColumns(cur, n) {
  const c2 = { s: cur.s, i: cur.i, col: cur.col, tabRest: cur.tabRest };
  if (n > 0) curSomeIndent(c2, n);
  return curRest(c2);
}

// The remainder with its leading whitespace run expanded: tabs become
// spaces according to their column. The reference lexer extracts block
// quote and list item contents as text (which performs this expansion)
// before re-lexing them, so content captured on a line that matched a
// container shows spaces where the raw line had tabs.
function restExpanded(cur, origin) {
  let out = '';
  let col = cur.col - origin;
  let i = cur.i;
  if (cur.tabRest > 0) {
    out = ' '.repeat(cur.tabRest);
    col += cur.tabRest;
  }
  const s = cur.s;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { out += ' '; col++; i++; }
    else if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out + s.slice(i);
}

function stripColsExpanded(cur, n, origin) {
  const e = restExpanded(cur, origin);
  let k = 0;
  while (k < e.length && e[k] === ' ' && k < n) k++;
  return e.slice(k);
}

// Parse the list-item marker at the cursor. On success the cursor sits at
// the item's content and the result carries the content indent (columns
// from the marker's start to the content). On failure the cursor is
// restored and null returned.
function scanListMarker(cur) {
  const sv = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
  const restore = () => { cur.i = sv.i; cur.col = sv.col; cur.tabRest = sv.tabRest; };
  const rest = curRest(cur);
  let bullet = null;
  let delim = null;
  let number = 0;
  let markerText = '';
  const c0 = rest[0];
  if (c0 === '-' || c0 === '+' || c0 === '*') {
    bullet = c0;
    markerText = c0;
  } else if (c0 >= '0' && c0 <= '9') {
    const m = /^([0-9]{1,9})([.)])/.exec(rest);
    if (!m) return null;
    number = parseInt(m[1], 10);
    delim = m[2];
    markerText = m[0];
  } else return null;
  for (const mc of markerText) curTake(cur, mc);
  const next = curPeek(cur);
  if (next !== '' && next !== ' ' && next !== '\t') { restore(); return null; }
  const blankAfter = curBlank(cur);
  const spacesCols = curSomeIndent(cur, 5);
  let padding;
  if (blankAfter || spacesCols >= 5) padding = 1;
  else padding = spacesCols;
  if (blankAfter || spacesCols >= 5) {
    restore();
    for (const mc of markerText) curTake(cur, mc);
    curIndent(cur, padding);
  }
  return { bullet, delim, number, contentIndent: markerText.length + padding, padding, empty: blankAfter };
}

function listMatches(list, marker) {
  if (marker.bullet) return list.bullet === marker.bullet;
  return list.bullet === null && list.delim === marker.delim;
}

// The block parser proper. Returns {root, defs}.
function parseBlocks(src) {
  const defs = new Map();
  const root = newBlock('doc');
  const lines = src.split('\n');
  // A trailing '' produced by a final newline is not a line.
  const hadFinalNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadFinalNewline) lines.pop();

  let tip = root; // deepest open block
  const stack = [root]; // open blocks, root first

  function openBlocks() { return stack; }
  function deepestLeaf() { return stack[stack.length - 1]; }

  function closeDownTo(index) {
    // Finalise and pop blocks deeper than stack[index].
    while (stack.length - 1 > index) {
      finalize(stack[stack.length - 1]);
      stack.pop();
    }
    tip = stack[stack.length - 1];
  }
  function finalize(b) {
    if (b.t === 'para') {
      const rest = extractDefs(b.text, defs);
      b.text = rest;
      b.removed = rest.trim() === '';
    } else if (b.t === 'list') {
      // Tight or loose: loose when an item ends on a blank line and is not
      // the last, or an item holds two blocks with a blank line between.
      let loose = false;
      const endsBlank = (blk) => blk.lastLineBlank ||
        (blk.children && blk.children.length > 0 && endsBlank(blk.children[blk.children.length - 1]));
      const items = b.children;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const kids = item.children;
        for (let j = 0; j < kids.length - 1; j++) {
          if (endsBlank(kids[j])) loose = true;
        }
        if (i < items.length - 1 && item.sepBlank) loose = true;
      }
      b.tight = !loose;
    } else if (b.t === 'code' && !b.fenced) {
      // Indented code: drop trailing blank lines.
      while (b.lines.length && b.lines[b.lines.length - 1].trim() === '') b.lines.pop();
    }
  }
  function addChild(parent, child) {
    parent.lastLineBlank = false;
    appendChild(parent, child);
    stack.push(child);
    tip = child;
    return child;
  }

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    let cur = lineCursor(rawLine);
    let container = root;
    let allMatched = true;
    let matchedDepth = 0; // stack index of deepest matched container
    let containerHit = false; // a quote or list item matched this line
    let originCol = 0; // column where the deepest container match began
    let baseCol = 0; // source column where the current container text began
    let contDepth = 0; // stack index of the deepest matched container

    // Phase 1: match open containers (and leaf continuations that are
    // decided here: fenced/indented code and HTML blocks).
    let leafAction = null; // 'code' | 'html' when the leaf swallows the line
    let failedItem = null; // the item whose indent match failed, if any
    for (let si = 1; si < stack.length; si++) {
      const b = stack[si];
      if (b.t === 'quote') {
        const sv = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
        curSomeIndent(cur, 3);
        if (curTake(cur, '>')) {
          if (curPeek(cur) === ' ' || curPeek(cur) === '\t') {
            // The reference expands the whitespace run after the
            // marker with tab stops relative to the parent text and
            // then drops a single character; a tab right after the
            // marker therefore leaves (relative width - 1) columns.
            if (cur.tabRest === 0 && cur.s[cur.i] === '\t') {
              const w = 4 - ((cur.col - baseCol) % 4);
              cur.i++;
              cur.col += 1;
              cur.tabRest = w - 1;
            } else curIndent(cur, 1);
          }
          container = b; matchedDepth = si; containerHit = true; originCol = sv.col;
          contDepth = si;
          baseCol = cur.col;
        } else {
          cur.i = sv.i; cur.col = sv.col; cur.tabRest = sv.tabRest;
          allMatched = false;
          break;
        }
      } else if (b.t === 'item') {
        if (b.children.length === 0 && b.lastLineBlank && !curBlank(cur)) {
          // An item that is still empty when a blank line has passed is
          // finished; it cannot pick up content afterwards.
          allMatched = false;
          failedItem = b;
          break;
        }
        if (curBlank(cur)) {
          container = b; matchedDepth = si; containerHit = true; contDepth = si;
          b._sv = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
        } else {
          const need = b.markerOffset + b.padding;
          const svI = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
          if (curIndentWidth(cur) >= need && curIndent(cur, need)) {
            container = b; matchedDepth = si; containerHit = true; contDepth = si;
            baseCol = cur.col;
            b._sv = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
          } else {
            cur.i = svI.i; cur.col = svI.col; cur.tabRest = svI.tabRest;
            allMatched = false;
            failedItem = b;
            break;
          }
        }
      } else if (b.t === 'list') {
        container = b; matchedDepth = si; contDepth = si;
      } else if (b.t === 'code') {
        if (b.fenced) {
          leafAction = 'code';
          container = b; matchedDepth = si;
        } else if (curIndentWidth(cur) >= 4 || curBlank(cur)) {
          leafAction = 'code';
          container = b; matchedDepth = si;
        } else {
          allMatched = false;
        }
        break;
      } else if (b.t === 'html') {
        if (b.ended) { allMatched = false; }
        else if ((b.htmlType === 6 || b.htmlType === 7) && curBlank(cur)) { allMatched = false; }
        else {
          leafAction = 'html';
          container = b; matchedDepth = si;
          b.trailingNL = li < lines.length - 1 || hadFinalNewline;
        }
        break;
      } else if (b.t === 'table') {
        leafAction = 'table';
        container = b; matchedDepth = si;
        break;
      } else {
        // para / heading leaves: heading never stays open; para matches
        // unless the line is blank.
        container = b; matchedDepth = si;
      }
    }

    // Remember each matched item's view of this line: the reference
    // list tokenizer collects an item's lines up front, and whether a
    // later under-indented line joins the item depends on the previous
    // line's text (blank, or itself block-like).
    for (let si = 1; si <= matchedDepth; si++) {
      const b = stack[si];
      if (b.t === 'item' && b._sv) {
        b.lastText = curRest({ s: rawLine, i: b._sv.i, col: b._sv.col, tabRest: b._sv.tabRest });
        b.lastBlank = b.lastText.trim() === '';
      }
    }

    // A blank line separates list items when it is blank in the
    // text of the list's current item: the remainder of the line
    // after that item's own match is all whitespace. (A blank line
    // inside a quote within the item leaves the quote marker in
    // that remainder, so it does not count; a blank line inside a
    // nested item leaves nothing, so it does.)
    if (leafAction !== 'code' && leafAction !== 'html') {
      for (let si = 1; si < stack.length; si++) {
        const b = stack[si];
        if (b.t !== 'list') continue;
        const item = b.children[b.children.length - 1];
        if (!item || !item._sv || contDepth < stack.indexOf(item)) continue;
        const rest = curRest({ s: rawLine, i: item._sv.i, col: item._sv.col, tabRest: item._sv.tabRest });
        if (/^[ \t]*$/.test(rest)) b.blankPending = true;
      }
    }

    const leaf = deepestLeaf();
    const paraOpen = leaf.t === 'para' && matchedDepth === stack.length - 1;

    if (leafAction === 'code' && leaf.t === 'code') {
      if (leaf.fenced) {
        // Closing fence?
        const sv = { s: cur.s, i: cur.i, col: cur.col, tabRest: cur.tabRest };
        curSomeIndent(sv, 3);
        const rest = curRest(sv);
        const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
        if (cm && cm[1][0] === leaf.fenceChar && cm[1].length >= leaf.fenceLen) {
          if (leaf.lines.length && leaf.lines[leaf.lines.length - 1] === '') leaf.lines.pop();
          closeDownTo(stack.length - 2);
        } else {
          leaf.lines.push(containerHit ? fenceLineText(restExpanded(cur, originCol), leaf) : fenceLineText(curRest(cur), leaf));
        }
      } else {
        leaf.lines.push(containerHit ? stripColsExpanded(cur, 4, originCol) : restAfterColumns(cur, 4));
      }
      afterLine(container, false);
      continue;
    }
    if (leafAction === 'html' && leaf.t === 'html') {
      const text = containerHit ? restExpanded(cur, originCol) : curRest(cur);
      leaf.lines.push(text);
      checkHtmlEnd(leaf, text);
      afterLine(container, false);
      continue;
    }
    if (leafAction === 'table' && leaf.t === 'table') {
      // A whitespace-only line ends the table only when it contains no
      // tab: the reference table tokenizer's blank-line test sees
      // spaces, so a tab-only line is collected as an (empty) row and
      // the table carries on.
      const restStr = curRest(cur);
      const wsOnly = curBlank(cur);
      const tabRow = cur.tabRest > 0 || rawLine.slice(cur.i).includes('\t');
      if (wsOnly && !tabRow) {
        closeDownTo(stack.length - 2);
      } else if (!wsOnly && startsBlockLine(cur)) {
        closeDownTo(stack.length - 2);
        incorporateLine(rawLine, cur, stack[stack.length - 1], null, -1, li < lines.length - 1 || hadFinalNewline, li === lines.length - 1, containerHit ? originCol : -1);
        continue;
      } else {
        leaf.rows.push(splitRow(containerHit ? restExpanded(cur, originCol) : curRest(cur)));
        afterLine(container, false);
        continue;
      }
    }

    if (!allMatched && failedItem && !curBlank(cur) &&
        ((leaf.t === 'code' && leaf.fenced) ||
         (leaf.t === 'code' && curIndentWidth(cur) >= 4) ||
         leaf.t === 'html' ||
         (leaf.t === 'table' && curIndentWidth(cur) < 4)) &&
        lazyItemChainOk(failedItem, leaf) && lazyItemEligible(failedItem, cur)) {
      // The reference list tokenizer collects an item's lines before
      // lexing them, so an under-indented line that starts no block
      // still lands inside the item — feeding an open fence, HTML block
      // or table there — even though the item's indent did not match.
      if (leaf.t === 'code' && leaf.fenced) {
        const sv = { s: cur.s, i: cur.i, col: cur.col, tabRest: cur.tabRest };
        curSomeIndent(sv, 3);
        const rest = curRest(sv);
        const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
        if (cm && cm[1][0] === leaf.fenceChar && cm[1].length >= leaf.fenceLen) {
          if (leaf.lines.length && leaf.lines[leaf.lines.length - 1] === '') leaf.lines.pop();
          closeDownTo(stack.length - 2);
        } else {
          leaf.lines.push(fenceLineText(curRest(cur), leaf));
        }
      } else if (leaf.t === 'code') {
        leaf.lines.push(restAfterColumns(cur, 4));
      } else if (leaf.t === 'html') {
        const text = curRest(cur);
        leaf.lines.push(text);
        checkHtmlEnd(leaf, text);
      } else {
        leaf.rows.push(splitRow(curRest(cur)));
      }
      failedItem.lastText = curRest(cur);
      failedItem.lastBlank = false;
      afterLine(stack[matchedDepth], false);
      continue;
    }

    if (!allMatched) {
      // Trailing-newline rule for HTML blocks, following the reference
      // raw-text cleanup: a block that already found its end marker
      // loses its final newline only when the next line is completely
      // empty (or its container chain broke); a block ended by a blank
      // line loses it on any blank line.
      if (leaf.t === 'html' && (matchedDepth < stack.indexOf(leaf.parent) ||
          (leaf.ended ? curDone(cur) : curBlank(cur)))) leaf.trailingNL = false;
      // Lazy continuation candidate: the deepest open leaf is a paragraph
      // and the line is not blank. Interrupting block starts are tried
      // first inside incorporateLine; if one claims the line, everything
      // down to the matched container is closed first.
      container = stack[matchedDepth];
      if (leaf.t === 'para' && !curBlank(cur)) {
        incorporateLine(rawLine, cur, container, leaf, matchedDepth, li < lines.length - 1 || hadFinalNewline, li === lines.length - 1, containerHit ? originCol : -1);
      } else {
        closeDownTo(matchedDepth);
        incorporateLine(rawLine, cur, container, null, -1, li < lines.length - 1 || hadFinalNewline, li === lines.length - 1, containerHit ? originCol : -1);
      }
    } else {
      incorporateLine(rawLine, cur, container, paraOpen ? leaf : null, -1, li < lines.length - 1 || hadFinalNewline, li === lines.length - 1, containerHit ? originCol : -1);
    }
  }

  closeDownTo(0);
  return { root, defs };

  // Does the line remainder at the cursor start a block (heading,
  // quote, fence, list marker, hr, HTML block)? Used for the list-item
  // lazy-line decision, where leading indent alone does not count.
  function startsBlockStart(cur) {
    const rest = curRest(cur).replace(/^ {0,3}/, '');
    if (/^#{1,6}(?:\s|$)/.test(rest)) return true;
    if (rest.charCodeAt(0) === 62) return true;
    if (/^(`{3,}|~{3,})/.test(rest)) return true;
    if (/^(?:[*+-]|\d{1,9}[.)])[ \t]/.test(rest)) return true;
    if ((rest.charCodeAt(0) === 42 || rest.charCodeAt(0) === 45 || rest.charCodeAt(0) === 95) && isThematicBreak(rest)) return true;
    if (rest.charCodeAt(0) === 60 && htmlBlockStart(rest, false)) return true;
    return false;
  }

  // The leaf must sit inside the failed item with no other item and no
  // block quote in between (a quote would end at the lazy line when the
  // item's text is re-lexed, taking the leaf with it).
  function lazyItemChainOk(item, leaf) {
    let a = leaf;
    while (a && a !== item) {
      if (a.t === 'quote') return false;
      if (a.t === 'item') return false;
      a = a.parent;
    }
    return a === item;
  }

  // Mirrors the reference list tokenizer's line-collection break
  // conditions: a lazy line joins the item unless the previous line in
  // the item was blank or itself block-like (indented code, a fence, a
  // heading, an HTML block, a rule), or the line itself starts a block.
  function lazyItemEligible(item, cur) {
    if (item.lastBlank) return false;
    const m = (item.lastText || '').replace(/\t/g, '    ');
    const fn = m.search(/\S/);
    if (fn >= 4) return false;
    if (fn !== -1 && startsBlockStart(lineCursor(m))) return false;
    if (startsBlockStart(cur)) return false;
    return true;
  }

  // Does the line remainder at the cursor start a block that would end
  // a table (per the reference table row continuation lookaheads)?
  function startsBlockLine(cur) {
    if (curIndentWidth(cur) >= 4) return true;
    const rest = curRest(cur).replace(/^ {0,3}/, '');
    if (/^#{1,6}(?:\s|$)/.test(rest)) return true;
    if (rest.charCodeAt(0) === 62) return true;
    if (/^(`{3,}|~{3,})/.test(rest)) return true;
    if (/^(?:[*+-]|1[.)])[ \t]/.test(rest)) return true;
    if ((rest.charCodeAt(0) === 42 || rest.charCodeAt(0) === 45 || rest.charCodeAt(0) === 95) && isThematicBreak(rest)) return true;
    if (rest.charCodeAt(0) === 60 && htmlBlockStart(rest, false)) return true;
    return false;
  }

  function afterLine(container, blank) {
    if (blank) {
      // Mark the deepest open block (that the blank line ended) for the
      // looseness computation.
      const leafNow = deepestLeaf();
      if (leafNow) leafNow.lastLineBlank = true;
    }
  }

  function checkHtmlEnd(b, line) {
    if (b.htmlType === 1) {
      if (line.toLowerCase().includes(b.endTag)) b.ended = true;
    } else if (b.htmlType === 2) {
      if (line.includes('-->')) b.ended = true;
    } else if (b.htmlType === 3) {
      if (line.includes('?>')) b.ended = true;
    } else if (b.htmlType === 4) {
      if (line.includes('>')) b.ended = true;
    } else if (b.htmlType === 5) {
      if (line.includes(']]>')) b.ended = true;
    }
    // Types 6 and 7 end when a blank line arrives; see incorporateLine.
  }

  // Phase 2 + 3 for one line, starting at `container` (the deepest matched
  // container) with cursor `cur`. openPara is the open paragraph leaf when
  // it sits at the tip (or null). lazyDepth >= 0 marks a lazy-continuation
  // candidate whose unmatched containers sit above stack[lazyDepth].
  function incorporateLine(rawLine, cur, container, openPara, lazyDepth, hasAfter, isLastLine, expanded) {
    let para = openPara;
    const hasQuoteAncestor = (blk) => {
      for (let a = blk.parent; a; a = a.parent) if (a.t === 'quote') return true;
      return false;
    };
    // A block start that interrupts the open paragraph: close the
    // paragraph (and, for a lazy line, everything the line did not match).
    const interruptPara = () => {
      if (!para) return;
      if (lazyDepth >= 0) closeDownTo(lazyDepth);
      else closeDownTo(stack.indexOf(para.parent));
      para = null;
      container = stack[stack.length - 1];
    };
    // A list whose current item did not match this line cannot parent a
    // new block (other than a new item of that same list, handled by the
    // list branch itself): close it before a block start claims the line.
    const popList = () => {
      if (container.t === 'list') {
        closeDownTo(stack.indexOf(container) - 1);
        container = stack[stack.length - 1];
      }
    };
    // Repeatedly try container starts (quote, list item), then leaf starts.
    let lastSv = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
    let firstCheck = true;
    for (;;) {
      lastSv = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
      const blank = curBlank(cur);
      if (blank && firstCheck && lazyDepth === -1 && para && isLastLine &&
          (!hasAfter || hasQuoteAncestor(para))) {
        para.text += '\n' + (expanded >= 0 ? restExpanded(cur, expanded) : curRest(cur));
        return;
      }
      if (blank) {
        // The blank line ends the deepest open block: remember that for
        // the list looseness computation, then close an open paragraph.
        // Only a line that is blank from its first check counts — the
        // empty remainder of a container-start line (e.g. "-") does not.
        const lf0 = deepestLeaf();
        if (firstCheck && lf0 && lf0 !== root) {
          lf0.lastLineBlank = true;
          if ((lf0.t === 'item' || lf0.t === 'quote') && lf0.children.length) {
            lf0.children[lf0.children.length - 1].lastLineBlank = true;
          }
        }
        interruptPara();
        // Blank lines end HTML blocks of type 6/7 and are otherwise inert.
        const lf = deepestLeaf();
        if (lf.t === 'html' && (lf.htmlType === 6 || lf.htmlType === 7)) {
          lf.trailingNL = false;
          closeDownTo(stack.length - 2);
        }
        return;
      }
      const sv = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
      const svCur = { s: cur.s, i: sv.i, col: sv.col, tabRest: sv.tabRest };
      // A line indented by 4+ columns cannot start a block: with a
      // paragraph open it is plain continuation text (kept verbatim);
      // without one it is indented code, handled at the bottom. A lazy
      // line (its containers did not match) instead loses exactly four
      // columns — the reference lexer's quote-chunk merging does that.
      if (para && curIndentWidth(svCur) >= 4) {
        para.text += '\n' + (lazyDepth >= 0
          ? (expanded >= 0 ? stripColsExpanded(svCur, 4, expanded) : restAfterColumns(svCur, 4))
          : (expanded >= 0 ? restExpanded(svCur, expanded) : curRest(svCur)));
        return;
      }
      const indent = curSomeIndent(cur, 3);
      void indent;
      const rest = curRest(cur);
      const ch = rest.charCodeAt(0);

      // Block quote start.
      if (ch === 62) { // '>'
        curTake(cur, '>');
        if (curPeek(cur) === ' ' || curPeek(cur) === '\t') curIndent(cur, 1);
        interruptPara();
        popList();
        container = addChild(container, newBlock('quote'));
        firstCheck = false;
        continue;
      }
      // ATX heading.
      if (ch === 35) { // '#'
        const m = /^(#{1,6})(?:[ \t]+|[ \t]*$)/.exec(rest);
        if (m) {
          interruptPara();
          popList();
          const h = addChild(container, newBlock('heading'));
          h.level = m[1].length;
          let text = rest.slice(m[0].length);
          text = text.replace(/[ \t]+$/, '');
          // Optional closing sequence of #s.
          text = text.replace(/(?:^|[ \t])#+$/, '').replace(/[ \t]+$/, '');
          h.text = text;
          closeDownTo(stack.length - 2);
          return;
        }
      }
      // Fenced code.
      if (ch === 96 || ch === 126) { // '`' or '~'
        const m = /^(`{3,}|~{3,})(.*)$/.exec(rest);
        if (m && (m[1][0] === '~' || !m[2].includes('`'))) {
          interruptPara();
          popList();
          const code = addChild(container, newBlock('code'));
          code.fenced = true;
          code.fenceChar = m[1][0];
          code.fenceLen = m[1].length;
          code.indent = indent;
          // The reference fence tokenizer compensates content lines by
          // the opening line's whitespace measured in characters (a
          // tab counts once), and only for backtick fences.
          code.indentChars = countWsChars(curRest(svCur));
          code.info = m[2].trim();
          code.lines = [];
          return;
        }
      }
      // HTML block.
      {
        const hb = htmlBlockStart(rest, !!para);
        if (hb) {
          interruptPara();
          popList();
          const hbNode = addChild(container, newBlock('html'));
          hbNode.htmlType = hb.type;
          hbNode.endTag = hb.endTag || null;
          hbNode.ended = false;
          hbNode.trailingNL = hasAfter;
          hbNode.lines = [curRest(svCur)];
          checkHtmlEnd(hbNode, rest);
          return;
        }
      }
      // Setext heading: the open paragraph's text becomes a heading. A
      // lazy underline line (one that did not match the paragraph's
      // containers) never converts: inside a block quote an '=' underline
      // degrades to literal paragraph text indented by four spaces, and
      // a '-' underline falls through to the thematic-break check.
      if (para) {
        const m = /^(=+|-+)[ \t]*$/.exec(rest);
        if (m) {
          if (lazyDepth === -1) {
            const restText = extractDefs(para.text, defs);
            if (restText.trim() === '') {
              // Only definitions preceded the underline: they are
              // consumed, and the line itself becomes the paragraph.
              para.text = rest;
              return;
            }
            // Heading text is trimmed at both ends in this dialect.
            para.text = restText.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
            para.t = 'heading';
            para.level = m[1][0] === '=' ? 1 : 2;
            closeDownTo(stack.indexOf(para.parent));
            return;
          }
          if (m[1][0] === '=') {
            let inQuote = false;
            for (let anc = para.parent; anc; anc = anc.parent) {
              if (anc.t === 'quote') { inQuote = true; break; }
            }
            if (inQuote) {
              para.text += '\n    ' + rest;
              return;
            }
          }
        }
      }
      // Thematic break.
      if (ch === 42 || ch === 45 || ch === 95) { // '*' '-' '_'
        if (isThematicBreak(rest)) {
          interruptPara();
          popList();
          addChild(container, newBlock('hr'));
          closeDownTo(stack.length - 2);
          return;
        }
      }
      // List item.
      {
        const sv2 = { i: cur.i, col: cur.col, tabRest: cur.tabRest };
        const marker = scanListMarker(cur);
        if (marker) {
          // The "empty items and ordered lists other than 1 do not
          // interrupt a paragraph" rule only protects a paragraph that
          // sits directly in the container the new list would join; a
          // paragraph inside a sibling item is simply ended by it.
          const target = para ? (lazyDepth >= 0 ? stack[lazyDepth] : para.parent) : container;
          const interrupts = !para || para.parent !== target ||
            (!marker.empty && (marker.bullet !== null || marker.number === 1 || target.t === 'item'));
          if (interrupts) {
            interruptPara();
            // Same list continuing?
            let list = container.t === 'list' && listMatches(container, marker) ? container : null;
            if (!list) {
              if (container.t === 'list') {
                closeDownTo(stack.indexOf(container.parent));
                container = stack[stack.length - 1];
              }
              list = addChild(container, newBlock('list'));
              list.bullet = marker.bullet;
              list.delim = marker.delim;
              list.start = marker.number;
              list.tight = true;
            }
            const prevItem = list.children[list.children.length - 1];
            if (prevItem && list.blankPending) prevItem.sepBlank = true;
            list.blankPending = false;
            const item = addChild(list, newBlock('item'));
            // Content indent is measured relative to the point where
            // this item's parent container was matched: markerOffset is
            // the marker's own offset from there, padding the columns
            // from the marker to the content.
            item.markerOffset = sv2.col - sv.col;
            item.padding = marker.contentIndent;
            container = item;
            firstCheck = false;
            continue;
          }
        }
        cur.i = sv2.i; cur.col = sv2.col; cur.tabRest = sv2.tabRest;
      }
      // Indented code (only when no paragraph is open).
      if (!para) {
        const svCur = { s: cur.s, i: sv.i, col: sv.col, tabRest: sv.tabRest };
        if (curIndentWidth(svCur) >= 4) {
          popList();
          const code = addChild(container, newBlock('code'));
          code.fenced = false;
          code.lines = [restAfterColumns(svCur, 4)];
          return;
        }
      }
      break;
    }

    // No block start claimed the line: it is paragraph content. The text
    // is the line as it stands after the matched containers — leading
    // spaces are part of the paragraph in this dialect.
    const restText = expanded >= 0
      ? restExpanded({ s: cur.s, i: lastSv.i, col: lastSv.col, tabRest: lastSv.tabRest }, expanded)
      : curRest({ s: cur.s, i: lastSv.i, col: lastSv.col, tabRest: lastSv.tabRest });
    if (para) {
      for (let a = para; a; a = a.parent) {
        if (a.t === 'item' && a.parent && a.parent.t === 'list') a.parent.blankPending = false;
      }
      // Table check: a one-line paragraph followed by a delimiter row
      // that matched the paragraph's containers (not a lazy line).
      if (lazyDepth === -1 && !para.text.includes('\n')) {
        const aligns = isDelimiterRow(curRest(cur));
        if (aligns) {
          const header = splitRow(para.text);
          if (header.length === aligns.length) {
            para.t = 'table';
            para.header = header;
            para.aligns = aligns;
            para.rows = [];
            return;
          }
        }
      }
      para.text += '\n' + restText;
      return;
    }
    // A lazy candidate whose paragraph was closed by an interrupting
    // block start also lands here: the remainder of the line starts a
    // fresh paragraph in the (possibly new) container.
    popList();
    const p = addChild(container, newBlock('para'));
    p.text = restText;
  }

  function curRestRaw(cur) {
    // The remainder of the raw line from the cursor, for indented code we
    // need the original characters; reconstruct from the raw line: the
    // cursor started at 0, so remainder is line minus consumed columns.
    return curRest(cur);
  }

  function markBlankChain() {
    // When a blank line arrives, every open block it "ends" for looseness
    // purposes is the deepest one; its ancestors inside items are marked at
    // their own finalisation through lastLineBlank on the item chain.
    const stackNow = openBlocks();
    for (let i = stackNow.length - 1; i >= 1; i--) {
      const b = stackNow[i];
      if (b.t === 'item') { b.sawBlank = true; break; }
      if (b.t === 'para' || b.t === 'code' || b.t === 'html' || b.t === 'heading' || b.t === 'table') continue;
    }
  }
}

function isThematicBreak(rest) {
  let count = 0;
  let sym = '';
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === ' ' || ch === '\t') continue;
    if (ch !== '*' && ch !== '-' && ch !== '_') return false;
    if (sym === '') sym = ch;
    else if (ch !== sym) return false;
    count++;
  }
  return count >= 3;
}

// ---------------------------------------------------------------------------
// Inline parsing
//
// A single scan builds a flat node list; '[' and '![' push bracket openers,
// '*'/'_'/'~' runs become delimiter nodes on a stack, and ']' tries to
// form a link. Emphasis is resolved with the standard delimiter-stack
// algorithm; GFM autolinks are applied afterwards to text nodes that do
// not sit inside a link.
// ---------------------------------------------------------------------------

const DISALLOWED_TAGS = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext']);
const WS_CHARS = ' \t\n\r\u000b\f             \u2028\u2029  　﻿';
function isWsChar(ch) { return ch === undefined || WS_CHARS.includes(ch); }
function isPunctChar(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.includes(ch);
  if (isWsChar(ch)) return false;
  return !/[\p{L}\p{N}]/u.test(ch);
}

function flanking(s, start, end) {
  const before = start > 0 ? s[start - 1] : undefined;
  const after = end < s.length ? s[end] : undefined;
  const beforeWs = isWsChar(before);
  const afterWs = isWsChar(after);
  const beforeP = isPunctChar(before);
  const afterP = isPunctChar(after);
  const left = !afterWs && (!afterP || beforeWs || beforeP);
  const right = !beforeWs && (!beforeP || afterWs || afterP);
  return { left, right, beforeP, afterP };
}

// Parse the "(destination title)" tail of an inline link starting at the
// '(' at position pos. Returns {href, title, end} or null.
function parseLinkTail(s, pos) {
  const n = s.length;
  let j = pos + 1;
  const skipWs = () => {
    let c = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; c++; }
    return c;
  };
  skipWs();
  let href;
  if (s[j] === '<') {
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < n && ASCII_PUNCT.includes(s[k + 1])) { k += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '<' || ch === '\n') return null;
      k++;
    }
    if (!ok) return null;
    href = unescapePunct(s.slice(j + 1, k));
    j = k + 1;
  } else {
    let k = j;
    let depth = 0;
    while (k < n) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < n && ASCII_PUNCT.includes(s[k + 1])) { k += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
      k++;
    }
    if (depth !== 0) return null;
    href = unescapePunct(s.slice(j, k));
    j = k;
  }
  const ws = skipWs();
  let title = null;
  if (j < n && s[j] !== ')') {
    if (ws === 0) return null;
    const q = s[j];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    const close = q === '(' ? ')' : q;
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < n && ASCII_PUNCT.includes(s[k + 1])) { k += 2; continue; }
      if (ch === close) { ok = true; break; }
      if (q === '(' && ch === '(') return null;
      k++;
    }
    if (!ok) return null;
    title = unescapePunct(s.slice(j + 1, k));
    j = k + 1;
    skipWs();
  }
  if (s[j] !== ')') return null;
  return { href, title, end: j + 1 };
}

// Scan a reference label starting after "]" + "[" at position pos (pos
// points at the second '['). Returns {label, end} or null.
function scanRefLabel(s, pos) {
  const n = s.length;
  let k = pos + 1;
  while (k < n) {
    const ch = s[k];
    if (ch === '\\' && k + 1 < n && ASCII_PUNCT.includes(s[k + 1])) { k += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') return { label: s.slice(pos + 1, k), end: k + 1 };
    k++;
  }
  return null;
}

function processEmphasis(nodes, stack, minIdx) {
  let ci = minIdx;
  while (ci < stack.length) {
    const closer = stack[ci];
    if (!closer.canClose || closer.len === 0) { ci++; continue; }
    let oi = -1;
    for (let j = ci - 1; j >= minIdx; j--) {
      const o = stack[j];
      if (o.ch !== closer.ch || !o.canOpen || o.len === 0) continue;
      if ((o.canClose || closer.canOpen) &&
          (o.len + closer.len) % 3 === 0 &&
          !(o.len % 3 === 0 && closer.len % 3 === 0)) continue;
      oi = j;
      break;
    }
    if (oi === -1) { ci++; continue; }
    const opener = stack[oi];
    const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
    const a = nodes.indexOf(opener.node);
    const b = nodes.indexOf(closer.node);
    const inner = nodes.splice(a + 1, b - a - 1);
    const wrap = {
      k: closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em',
      children: inner,
    };
    nodes.splice(a + 1, 0, wrap);
    opener.len -= use;
    closer.len -= use;
    opener.node.len = opener.len;
    closer.node.len = closer.len;
    stack.splice(oi + 1, ci - oi - 1);
    ci = stack.indexOf(closer);
    if (opener.len === 0) {
      const ni = nodes.indexOf(opener.node);
      if (ni !== -1) nodes.splice(ni, 1);
      stack.splice(stack.indexOf(opener), 1);
      ci = stack.indexOf(closer);
    }
    if (closer.len === 0) {
      const ni = nodes.indexOf(closer.node);
      if (ni !== -1) nodes.splice(ni, 1);
      stack.splice(ci, 1);
    }
  }
}

const INLINE_HTML_RES = [
  /^<!--(?:-?>|[\s\S]*?(?:-->|$))/,
  /^<\?[\s\S]*?\?>/,
  /^<![A-Za-z][^>]*>/,
  /^<!\[CDATA\[[\s\S]*?\]\]>/,
];
const ATTR_INLINE = '(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"\'`=<>]+|\'[^\']*\'|"[^"]*"))?)';
const OPEN_TAG_FULL = new RegExp('^<' + TAG_NAME + ATTR_INLINE + '*\\s*/?>');
const CLOSE_TAG_FULL = new RegExp('^</' + TAG_NAME + '\\s*>');
const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_AUTOLINK_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

// If raw inline HTML starts at position i of s, return [rawText, endIndex]
// or null. Disallowed GFM tags are reported through the second element of
// the result being the string 'text'.
function matchInlineHtml(s, i) {
  const rest = s.slice(i);
  for (const re of INLINE_HTML_RES) {
    const m = re.exec(rest);
    if (m) return [m[0], i + m[0].length, 'html'];
  }
  let m = OPEN_TAG_FULL.exec(rest) || CLOSE_TAG_FULL.exec(rest);
  if (m) {
    return [m[0], i + m[0].length, 'html'];
  }
  return null;
}

// Document-wide inline state, mirroring the reference lexer: an inline
// <a ...> tag token suppresses GFM autolinks from that point on (across
// block boundaries) until a </a> tag token appears; an inline
// pre/code/kbd/script tag switches text to raw (unescaped) mode until
// its end tag. Text nodes are stamped with the state in effect where
// they were scanned.
let INLINE_STATE = { a: false, raw: false };
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_RAW_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_RAW_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
function noteInlineTag(raw) {
  if (!INLINE_STATE.a && START_A_TAG.test(raw)) INLINE_STATE.a = true;
  else if (INLINE_STATE.a && END_A_TAG.test(raw)) INLINE_STATE.a = false;
  if (!INLINE_STATE.raw && START_RAW_TAG.test(raw)) INLINE_STATE.raw = true;
  else if (INLINE_STATE.raw && END_RAW_TAG.test(raw)) INLINE_STATE.raw = false;
}

// ---------------------------------------------------------------------------
// Emphasis and strikethrough, following the reference tokenizer's own
// algorithm rather than the CommonMark delimiter-stack rules: at a '*'/'_'
// run the tokenizer tries to form a complete em/strong token by scanning
// the (masked) remainder with a set of context-sensitive delimiter
// patterns; '~' runs form del tokens the same way. The mask hides
// delimiters inside links, code spans and HTML, and neutralises escaped
// punctuation, so the closer search sees the same text the reference
// lexer sees. The content of a formed token is lexed recursively.
// ---------------------------------------------------------------------------

const PUNCT_CLASS = '[\\p{P}\\p{S}]';
const PUNCT_SPACE_CLASS = '[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_CLASS = '[^\\s\\p{P}\\p{S}]';
// In the default (gfm, no breaks) rule set the emphasis patterns use
// tilde-aware classes: "punct" excludes '~', and the not-punct-space
// class additionally allows '~'.
const EM_PUNCT = '(?!~)[\\p{P}\\p{S}]';
const EM_PUNCT_SPACE = '(?!~)[\\s\\p{P}\\p{S}]';
const EM_NOT_PUNCT_SPACE = '(?:[^\\s\\p{P}\\p{S}]|~)';
const EM_LD_RE = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_RD_AST_RE = new RegExp(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' +
  '|[^*]+(?=[^*])' +
  '|(?!\\*)' + EM_PUNCT + '(\\*+)(?=[\\s]|$)' +
  '|' + EM_NOT_PUNCT_SPACE + '(\\*+)(?!\\*)(?=' + EM_PUNCT_SPACE + '|$)' +
  '|(?!\\*)' + EM_PUNCT_SPACE + '(\\*+)(?=' + EM_NOT_PUNCT_SPACE + ')' +
  '|[\\s](\\*+)(?!\\*)(?=' + EM_PUNCT + ')' +
  '|(?!\\*)' + EM_PUNCT + '(\\*+)(?!\\*)(?=' + EM_PUNCT + ')' +
  '|' + EM_NOT_PUNCT_SPACE + '(\\*+)(?=' + EM_NOT_PUNCT_SPACE + ')', 'gu');
const EM_RD_UND_RE = new RegExp(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' +
  '|[^_]+(?=[^_])' +
  '|(?!_)' + PUNCT_CLASS + '(_+)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_SPACE_CLASS + '(_+)(?!_)(?=' + PUNCT_SPACE_CLASS + '|$)' +
  '|(?!_)' + PUNCT_SPACE_CLASS + '(_+)(?=' + NOT_PUNCT_SPACE_CLASS + ')' +
  '|[\\s](_+)(?!_)(?=' + PUNCT_CLASS + ')' +
  '|(?!_)' + PUNCT_CLASS + '(_+)(?!_)(?=' + PUNCT_CLASS + ')', 'gu');
const DEL_LD_RE = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const DEL_RD_RE = new RegExp(
  '^[^~]+(?=[^~])' +
  '|(?!~)' + PUNCT_CLASS + '(~~?)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_SPACE_CLASS + '(~~?)(?!~)(?=' + PUNCT_SPACE_CLASS + '|$)' +
  '|(?!~)' + PUNCT_SPACE_CLASS + '(~~?)(?=' + NOT_PUNCT_SPACE_CLASS + ')' +
  '|[\\s](~~?)(?!~)(?=' + PUNCT_CLASS + ')' +
  '|(?!~)' + PUNCT_CLASS + '(~~?)(?!~)(?=' + PUNCT_CLASS + ')' +
  '|' + NOT_PUNCT_SPACE_CLASS + '(~~?)(?=' + NOT_PUNCT_SPACE_CLASS + ')', 'gu');
const PUNCT_NT_RE = /^(?![*_])[\s\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

const LABEL_LE_SRC = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LABEL_LT_SRC = '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + LABEL_LE_SRC + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const REF_BE_SRC = '(?:(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\])){1,999}';
const REFLINK_SEARCH_RE = new RegExp(
  '!?(?:\\[' + LABEL_LT_SRC + '\\]\\[' + REF_BE_SRC + '\\])' +
  '|!?\\[' + REF_BE_SRC + '\\](?:\\[\\])?(?!\\()', 'g');
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

function linkInText(e, defs) {
  if (!e.includes('[')) return false;
  for (const m of e.matchAll(BLOCK_SKIP_RE)) {
    if (m[0].charAt(0) === '[' && e.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of e.matchAll(REFLINK_SEARCH_RE)) {
    const str = m[0];
    const o = str.lastIndexOf('[');
    if (defs.has(normaliseLabel(str.slice(o + 1, -1)))) return true;
  }
  return false;
}

// Build the masked copy of an inline text used by the emphasis closer
// search: reference-style link labels/refs collapse to runs of 'a',
// escaped punctuation becomes '+', and link/code/HTML spans collapse to
// bracketed 'a' runs. Length is preserved throughout.
function buildMasked(src, defs) {
  let t = src;
  if (defs.size > 0 && src.includes('[')) {
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!defs.has(normaliseLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, defs)) {
          return '[' + inner.replace(REFLINK_SEARCH_RE, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH_RE, maskRef);
  }
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (m, s, r) =>
    r ? '+'.repeat(m.length)
      : s ? s + m.slice(s.length, m.length - s.length).replace(/`/g, '+') + s
        : m);
  t = t.replace(BLOCK_SKIP_RE, (m, p1, p2) => {
    const o = p2 ? p2.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(Math.max(0, m.length - o - 2)) + ']';
  });
  return t;
}

// For each delimiter character, the start index of the last run in the
// masked text that is preceded by a non-space character (runs elsewhere
// can never be closers). Mirrors the reference lexer's index computation.
function computeLastCloser(masked) {
  const res = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') res[r] = s;
    s = i - 1;
  }
  return res;
}

// Try to form an em/strong token at the start of src (src is the
// remaining original text; maskInfo describes the whole segment).
// Returns {len, kind, content} or null.
function tryEmStrong(src, maskInfo, prevChar) {
  const m = EM_LD_RE.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const r = m[0][0];
  const sameChar = prevChar === r;
  const full = maskInfo.masked;
  const off = full.length - src.length;
  let l = off;
  while (l > 0 && full[l - 1] === r) l--;
  let p = '';
  if (l > 0) p = [...full.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || (p !== '' && PUNCT_NT_RE.test(p));
  let n = prevChar;
  if (l < off) n = p;
  const u = l < off ? h : PUNCT_NT_RE.test(n);
  if (m[4] && ALNUM_RE.test(n)) return null;
  const d = m[1] || m[3] || '';
  if (!(!d || !n || u)) return null;
  const k = [...m[0]].length - 1;
  let need = k;
  let f = 0;
  const y = off - l + k;
  const canClosePrev = !!p.trim() && (!!d || (r === '*' && !h));
  const v = maskInfo.closers[r];
  const q = off + k;
  if (v < q) return null;
  const t = full.slice(off + k);
  const ee = v - q;
  const RD = r === '*' ? EM_RD_AST_RE : EM_RD_UND_RE;
  RD.lastIndex = 0;
  let sm;
  while ((sm = RD.exec(t)) !== null && !(sm.index > ee)) {
    const g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
    if (!g) continue;
    const b = [...g].length;
    if (sm[3] || sm[4]) { need += b; continue; }
    if (sm[5] || sm[6] || canClosePrev) {
      if (sameChar && (sm[5] || sm[6])) break;
      if (y % 3 && !((y + b) % 3)) { f += b; continue; }
    }
    need -= b;
    if (need > 0) continue;
    const bb = Math.min(b, b + need + f);
    const te = [...sm[0]][0].length;
    const rawLen = k + sm.index + te + bb;
    const raw = src.slice(0, rawLen);
    if (Math.min(k, bb) % 2) return { len: rawLen, kind: 'em', content: raw.slice(1, -1) };
    return { len: rawLen, kind: 'strong', content: raw.slice(2, -2) };
  }
  return null;
}

// Try to form a del token at the start of src. Returns {len, content}
// or null.
function tryDel(src, maskInfo, prevChar) {
  const m = DEL_LD_RE.exec(src);
  if (!m) return null;
  if (!(!(m[1] || '') || !prevChar || PUNCT_NT_RE.test(prevChar))) return null;
  const o = [...m[0]].length - 1;
  let need = o;
  const full = maskInfo.masked;
  const u = maskInfo.closers['~'];
  const d = full.length - src.length + o;
  if (u < d) return null;
  const t = full.slice(full.length - src.length + o);
  const kk = u - d;
  DEL_RD_RE.lastIndex = 0;
  let sm;
  while ((sm = DEL_RD_RE.exec(t)) !== null && !(sm.index > kk)) {
    const g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
    if (!g) continue;
    const len = [...g].length;
    if (len !== o) continue;
    if (sm[3] || sm[4]) { need += len; continue; }
    need -= len;
    if (need > 0) continue;
    const ll = Math.min(len, len + need);
    const gg = [...sm[0]][0].length;
    const rawLen = o + sm.index + gg + ll;
    const raw = src.slice(0, rawLen);
    return { len: rawLen, content: raw.slice(o, rawLen - o) };
  }
  return null;
}

// Simulate the reference link label pattern starting at the '[' at
// index `start`: returns the set of indices at which the label can
// end (the pattern is a sequence of nested-bracket groups, backslash
// escapes, code spans — an opener run, non-backtick content, and the
// next backtick run as the closer — plus a run of 2+ backticks
// directly before ']' as an alternative way to reach a label end).
function matchLabelEnds(s, start) {
  const n = s.length;
  const ends = new Set();
  let budget = 200000;
  function scan(j) {
    while (j < n) {
      if (--budget < 0) return;
      const c = s[j];
      if (c === ']') { ends.add(j); return; }
      if (c === '\\') { j += 2; continue; }
      if (c === '[') {
        // A bracket group: \[ (?: Le | escape | plain )* \] where Le
        // is \[ (?: escape | plain )* \]. Its extent is
        // deterministic: content items are forced at each position.
        let k = j + 1;
        let ok = false;
        while (k < n) {
          const d = s[k];
          if (d === '\\') { k += 2; continue; }
          if (d === ']') { ok = true; break; }
          if (d === '[') {
            let m = k + 1;
            let ok2 = false;
            while (m < n) {
              const e = s[m];
              if (e === '\\') { m += 2; continue; }
              if (e === ']') { ok2 = true; break; }
              if (e === '[') break;
              m++;
            }
            if (!ok2) return;
            k = m + 1;
            continue;
          }
          k++;
        }
        if (!ok) return;
        j = k + 1;
        continue;
      }
      if (c === '`') {
        let r = 1;
        while (s[j + r] === '`') r++;
        const q = s.indexOf('`', j + r);
        if (q !== -1) {
          let r2 = 1;
          while (s[q + r2] === '`') r2++;
          scan(q + r2);
        }
        if (r >= 2 && s[j + r] === ']') ends.add(j + r);
        return;
      }
      j++;
    }
  }
  scan(start + 1);
  return ends;
}

function parseInlineNodes(text, defs) {
  const s = text;
  const n = s.length;
  const nodes = [];
  const stack = [];
  const openers = [];
  let buf = '';
  let i = 0;
  // Masked text + closer index for the reference-style emphasis
  // attempts, computed once per segment (as the reference lexer does).
  let maskInfo = null;
  if (s.includes('*') || s.includes('_') || s.includes('~')) {
    const masked = buildMasked(s, defs);
    maskInfo = { masked, closers: computeLastCloser(masked) };
  }
  // prevChar tracking for emphasis attempts: the reference lexer passes
  // the last character of the preceding text token (a trailing '_' does
  // not update it); any non-text token resets it to ''.
  let textSince = false;
  let rPrev = '';
  const flush = () => {
    if (buf) {
      nodes.push({ k: 'text', s: buf, nl: INLINE_STATE.a, raw: INLINE_STATE.raw });
      const lc = buf[buf.length - 1];
      if (lc !== '_') rPrev = lc;
      textSince = true;
      buf = '';
    }
  };

  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        // A backslash immediately after an autolink candidate belongs
        // to the URL: the reference url tokenizer consumes it before
        // the break rule can fire. The newline then reads as a soft
        // break.
        const um = /((?:https?|ftp):\/\/[^\s<]*|www\.[^\s<]*)$/i.exec(buf);
        if (um) {
          const p = buf.length - um[1].length;
          if (p === 0 || !/[A-Za-z0-9/@]/.test(buf[p - 1])) {
            buf += '\\';
            flush();
            nodes.push({ k: 'soft' });
            textSince = false;
            i += 2;
            continue;
          }
        }
        flush();
        nodes.push({ k: 'hard' });
        textSince = false;
        i += 2;
        while (s[i] === ' ' || s[i] === '\t') i++;
      } else if (nx !== undefined && ASCII_PUNCT.includes(nx)) {
        buf += nx;
        i += 2;
      } else {
        buf += c;
        i++;
      }
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      // Find a closing run of exactly the same length.
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (s[j] === '`') {
          let r2 = 1;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      // Inside a bracket label, a span that would swallow a ']' the
      // label pattern can end at never forms: the reference
      // tokenizer tries the link pattern at the '[' first. Leave the
      // backticks as literal text then, and let the ']' logic
      // decide the bracket's fate.
      let blocked = false;
      if (found !== -1 && openers.length > 0) {
        for (let j = openers.length - 1; j >= 0; j--) {
          if (!openers[j].active) continue;
          const ends = matchLabelEnds(s, openers[j].srcStart - 1);
          for (const e of ends) {
            if (e >= i + run && e < found) { blocked = true; break; }
          }
          break;
        }
      }
      if (found === -1 || blocked) {
        buf += '`'.repeat(run);
        i += run;
      } else {
        flush();
        let content = s.slice(i + run, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        nodes.push({ k: 'code', s: content });
        textSince = false;
        i = found + run;
      }
      continue;
    }
    if (c === '<') {
      let m = AUTOLINK_RE.exec(s.slice(i));
      if (m) {
        flush();
        const dest = m[1];
        nodes.push({
          k: 'link', href: dest, title: null, auto: 1,
          children: [{ k: 'text', s: dest }],
        });
        textSince = false;
        i += m[0].length;
        continue;
      }
      m = EMAIL_AUTOLINK_RE.exec(s.slice(i));
      if (m) {
        flush();
        nodes.push({
          k: 'link', href: 'mailto:' + m[1], title: null, auto: 1,
          children: [{ k: 'text', s: m[1] }],
        });
        textSince = false;
        i += m[0].length;
        continue;
      }
      const html = matchInlineHtml(s, i);
      if (html) {
        flush();
        if (html[2] === 'html') {
          nodes.push({ k: 'html', s: html[0] });
          noteInlineTag(html[0]);
          textSince = false;
        } else {
          nodes.push({ k: 'text', s: html[0], nl: INLINE_STATE.a, raw: INLINE_STATE.raw });
          const lc = html[0][html[0].length - 1];
          if (lc !== '_') rPrev = lc;
          textSince = true;
        }
        i = html[1];
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '&') {
      const ent = matchEntity(s, i);
      if (ent) {
        if (ent[0] === RAW_ENTITY) {
          flush();
          nodes.push({ k: 'raw', s: s.slice(i, ent[1]) });
          rPrev = ';';
          textSince = true;
        } else {
          buf += ent[0];
        }
        i = ent[1];
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      flush();
      const node = { k: 'bracket', s: '![', len: 0 };
      nodes.push(node);
      textSince = false;
      openers.push({ node, isImage: true, active: true, srcStart: i + 2, delimBottom: stack.length });
      i += 2;
      continue;
    }
    if (c === '[') {
      flush();
      const node = { k: 'bracket', s: '[', len: 0 };
      nodes.push(node);
      textSince = false;
      openers.push({ node, isImage: false, active: true, srcStart: i + 1, delimBottom: stack.length });
      i++;
      continue;
    }
    if (c === ']') {
      flush();
      const formed = tryFormLink(i);
      if (formed) { i = formed; textSince = false; continue; }
      buf += c;
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (s[i + run] === c) run++;
      if (c === '~' && run >= 3) { buf += '~'.repeat(run); i += run; continue; }
      if (openers.length === 0 && maskInfo) {
        // No bracket is open: try the reference tokenizer's
        // form-a-whole-token attempt at this run.
        flush();
        const pc = textSince ? rPrev : '';
        if (c === '~') {
          const att = tryDel(s.slice(i), maskInfo, pc);
          if (att) {
            nodes.push({ k: 'del', children: parseInlineNodes(att.content, defs) });
            textSince = false;
            i += att.len;
            continue;
          }
          // A failed del attempt leaves the whole run as text.
          buf += '~'.repeat(run);
          i += run;
          continue;
        }
        const att = tryEmStrong(s.slice(i), maskInfo, pc);
        if (att) {
          nodes.push({ k: att.kind, children: parseInlineNodes(att.content, defs) });
          textSince = false;
          i += att.len;
          continue;
        }
        // A failed em/strong attempt leaves one character as text;
        // the rest of the run is retried at the next position.
        buf += c;
        i++;
        continue;
      }
      if (openers.length > 0 && maskInfo) {
        // Inside a bracket label, the reference tokenizer still
        // makes its own emphasis attempt at each run — unless the
        // bracket is going to form a link or image, in which case
        // the label text is lexed afresh at the ']' and any
        // delimiters collected meanwhile are discarded with it.
        const O = openers[openers.length - 1];
        if (O && !linkFate(O)) {
          flush();
          const pc = textSince ? rPrev : '';
          if (c === '~') {
            const att = tryDel(s.slice(i), maskInfo, pc);
            if (att) {
              nodes.push({ k: 'del', children: parseInlineNodes(att.content, defs) });
              textSince = false;
              i += att.len;
              continue;
            }
            buf += '~'.repeat(run);
            i += run;
            continue;
          }
          const att = tryEmStrong(s.slice(i), maskInfo, pc);
          if (att) {
            nodes.push({ k: att.kind, children: parseInlineNodes(att.content, defs) });
            textSince = false;
            i += att.len;
            continue;
          }
          buf += c;
          i++;
          continue;
        }
      }
      const f = flanking(s, i, i + run);
      let canOpen;
      let canClose;
      if (c === '*') { canOpen = f.left; canClose = f.right; }
      else if (c === '_') {
        canOpen = f.left && (!f.right || f.beforeP);
        canClose = f.right && (!f.left || f.afterP);
      } else {
        canOpen = f.left;
        canClose = f.right;
      }
      if (!canOpen && !canClose) { buf += c.repeat(run); i += run; continue; }
      flush();
      const node = { k: 'delim', ch: c, len: run, nl: INLINE_STATE.a, raw: INLINE_STATE.raw };
      nodes.push(node);
      textSince = false;
      stack.push({ node, ch: c, len: run, canOpen, canClose });
      i += run;
      continue;
    }
    if (c === '\n') {
      // Hard break when the text so far ends in two or more spaces: the
      // break eats the next line's leading spaces. A soft break keeps
      // them — this dialect preserves continuation-line indentation.
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        nodes.push({ k: 'hard' });
        textSince = false;
        i++;
        while (s[i] === ' ' || s[i] === '\t') i++;
      } else {
        flush();
        nodes.push({ k: 'soft' });
        textSince = false;
        i++;
      }
      continue;
    }
    // Plain text run.
    let j = i + 1;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' || ch === '`' || ch === '<' || ch === '&' || ch === '[' || ch === ']' ||
          ch === '*' || ch === '_' || ch === '~' || ch === '\n') break;
      if (ch === '!' && s[j + 1] === '[') break;
      j++;
    }
    buf += s.slice(i, j);
    i = j;
  }
  flush();
  processEmphasis(nodes, stack, 0);
  return nodes;

  // Will this bracket opener form a link or image at one of its
  // reachable label ends? Mirrors the checks tryFormLink performs.
  function linkFate(O) {
    if (O.fate !== undefined) return O.fate;
    let fate = false;
    const ends = [...matchLabelEnds(s, O.srcStart - 1)].sort((a, b) => a - b);
    for (const e of ends) {
      let ok = false;
      if (s[e + 1] === '(') {
        ok = !!parseLinkTail(s, e + 1);
      } else if (s[e + 1] === '[') {
        const lab = scanRefLabel(s, e + 1);
        if (lab) {
          const labelText = lab.label === '' ? s.slice(O.srcStart, e) : lab.label;
          ok = defs.has(normaliseLabel(labelText));
        }
      } else {
        ok = defs.has(normaliseLabel(s.slice(O.srcStart, e)));
      }
      if (!ok) continue;
      if (O.isImage) { fate = true; break; }
      const fresh = parseInlineNodes(s.slice(O.srcStart, e), defs);
      const containsLink = (list) => list.some(nd =>
        (nd.k === 'link' && !nd.auto) || (nd.children && containsLink(nd.children)));
      if (!containsLink(fresh)) { fate = true; break; }
    }
    O.fate = fate;
    return fate;
  }

  function tryFormLink(closeIdx) {
    // Nearest active opener.
    let oi = -1;
    for (let j = openers.length - 1; j >= 0; j--) {
      if (openers[j].active) { oi = j; break; }
    }
    if (oi === -1) return 0;
    const opener = openers[oi];
    if (opener.isImage) {
      // An image forms only at the bracket that balances its label:
      // openers pushed after it that can never form (link openers
      // deactivated by an inner link) spend this ']' as their own
      // failed closer, one per ']'.
      let spent = false;
      for (let j = openers.length - 1; j > oi; j--) {
        if (!openers[j].isImage && !openers[j].active) {
          openers.splice(j, 1);
          spent = true;
          break;
        }
      }
      if (spent) return 0;
    }
    // The reference link pattern must end its label exactly at this
    // ']': a ']' the label pattern swallows (inside a code span or a
    // nested bracket group) or never reaches cannot close a link.
    if (!matchLabelEnds(s, opener.srcStart - 1).has(closeIdx)) return 0;
    let href = null;
    let title = null;
    let end = 0;
    if (s[closeIdx + 1] === '(') {
      const tail = parseLinkTail(s, closeIdx + 1);
      if (tail) {
        href = tail.href;
        title = tail.title;
        end = tail.end;
      } else {
        // Not a valid inline link: the bracket may still be a shortcut
        // reference, with the "(...)" left as literal text.
        const labelText = s.slice(opener.srcStart, closeIdx);
        const def = defs.get(normaliseLabel(labelText));
        if (!def) { openers.splice(oi, 1); return 0; }
        href = def.href;
        title = def.title;
        end = closeIdx + 1;
      }
    } else {
      let labelText;
      let after = closeIdx + 1;
      if (s[closeIdx + 1] === '[') {
        const lab = scanRefLabel(s, closeIdx + 1);
        if (!lab) { openers.splice(oi, 1); return 0; }
        labelText = lab.label === '' ? s.slice(opener.srcStart, closeIdx) : lab.label;
        after = lab.end;
      } else {
        labelText = s.slice(opener.srcStart, closeIdx);
      }
      const def = defs.get(normaliseLabel(labelText));
      if (!def) { openers.splice(oi, 1); return 0; }
      href = def.href;
      title = def.title;
      end = after;
    }
    // Resolve emphasis among the delimiters inside the brackets.
    processEmphasis(nodes, stack, opener.delimBottom);
    const bi = nodes.indexOf(opener.node);
    // Once the link is known to form, the reference lexer lexes the
    // label text afresh as its own inline segment; do the same so
    // constructs inside the label (code spans whose runs interact with
    // the bracket, especially) get their standalone reading instead of
    // the incremental scan's.
    const fresh = parseInlineNodes(s.slice(opener.srcStart, closeIdx), defs);
    if (!opener.isImage) {
      // A link may not contain another bracket link anywhere inside it
      // (autolinks inside the text are fine).
      const containsLink = (list) => list.some(nd =>
        (nd.k === 'link' && !nd.auto) || (nd.children && containsLink(nd.children)));
      if (containsLink(fresh)) {
        openers.splice(oi, 1);
        return 0;
      }
    }
    const children = fresh;
    nodes.splice(bi + 1);
    nodes.splice(bi, 1);
    const linkNode = { k: opener.isImage ? 'img' : 'link', href, title, children };
    nodes.push(linkNode);
    stack.length = opener.delimBottom;
    openers.length = oi;
    if (!opener.isImage) {
      for (const o of openers) if (!o.isImage) o.active = false;
    }
    return end;
  }
}

// ---------------------------------------------------------------------------
// URL handling and the GFM autolink pass
// ---------------------------------------------------------------------------

// Prepare a link destination for the href attribute: character references
// are decoded, then characters that cannot appear literally in a URL are
// percent-encoded (UTF-8), keeping existing escapes and URL punctuation.
function cleanUrl(href) {
  const decoded = href;
  let out = '';
  for (let i = 0; i < decoded.length; i++) {
    const ch = decoded[i];
    const cp = decoded.codePointAt(i);
    if (cp > 0xffff) {
      out += encodeURIComponent(ch);
      i++;
      continue;
    }
    if (cp < 0x21 || cp === 0x7f || ch === '"' || ch === '<' || ch === '>' || ch === '\\' || ch === '^' || ch === '`' || ch === '{' || ch === '|' || ch === '}' || ch === '[' || ch === ']' || cp > 0x7e) {
      out += encodeURIComponent(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

const WWW_RE = /^www\.[A-Za-z0-9]/;
const SCHEME_RE = /^(?:https?|ftp):\/\//i;
// Extended email autolink: a local part of symbol-ish characters, then a
// domain of dot-separated segments (at least one dot). A candidate that
// ends in '-' or '_' is not a link at all.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\-=?^_`{|}~]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/;
function matchEmail(text, i) {
  const m = EMAIL_RE.exec(text.slice(i));
  if (!m) return null;
  const last = m[0][m[0].length - 1];
  if (last === '-' || last === '_') return null;
  return m[0];
}

// Trim a candidate extended autolink the way the reference url
// tokenizer does: repeatedly keep the longest prefix consumable in
// chunks of ordinary characters, balanced "(...)" groups, '&' not
// ending an entity-shaped tail, and punctuation runs that do not
// reach the end of the candidate.
const AUTOLINK_PUNCT = '?!.,:;*_\'"~)';
function backpedalOnce(str) {
  const n = str.length;
  let i = 0;
  while (i < n) {
    const ch = str[i];
    if (ch === '(') {
      const close = str.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === '&') {
      if (/^[a-zA-Z0-9]+;$/.test(str.slice(i + 1))) break;
      i++;
      continue;
    }
    if (AUTOLINK_PUNCT.includes(ch)) {
      let j = i;
      while (j < n && AUTOLINK_PUNCT.includes(str[j])) j++;
      if (j === n) { i = n - 1; break; }
      i = j;
      continue;
    }
    let j = i;
    while (j < n && str[j] !== '(' && str[j] !== '&' && !AUTOLINK_PUNCT.includes(str[j])) j++;
    i = j;
  }
  return str.slice(0, i);
}
function trimAutolink(url) {
  let u = url;
  for (;;) {
    const v = backpedalOnce(u);
    if (v === u) return u;
    u = v;
  }
}

// Split a raw text string into text and autolink nodes (GFM extended
// autolinks). Returns an array of nodes.
function linkifyText(text) {
  const out = [];
  const n = text.length;
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push({ k: 'text', s: buf }); buf = ''; } };
  while (i < n) {
    const c = text[i];
    const prevOk = i === 0 || !/[A-Za-z0-9/@]/.test(text[i - 1]);
    if (prevOk && (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F')) {
      const rest = text.slice(i);
      let url = null;
      let isWww = false;
      if (WWW_RE.test(rest)) isWww = true;
      if (isWww || SCHEME_RE.test(rest)) {
        let j = i;
        while (j < n && !/[\s<]/.test(text[j])) j++;
        url = trimAutolink(text.slice(i, j));
        if (url && (isWww ? url.length > 4 : url.length > 7)) {
          flush();
          out.push({
            k: 'link', href: isWww ? 'http://' + url : url, title: null, auto: 1,
            children: [{ k: 'text', s: url }],
          });
          i += url.length;
          continue;
        }
      }
    }
    // mailto:/xmpp: prefixed forms: the whole thing becomes the link.
    if (prevOk && (c === 'm' || c === 'x')) {
      const rest = text.slice(i);
      const pm = /^(mailto|xmpp):/.exec(rest);
      if (pm) {
        const em = matchEmail(text, i + pm[0].length);
        if (em) {
          let whole = pm[0] + em;
          if (pm[1] === 'xmpp' && text[i + whole.length] === '/') {
            const rm = /^\/[A-Za-z0-9@._~-]+/.exec(text.slice(i + whole.length));
            if (rm) whole += rm[0];
          }
          flush();
          out.push({
            k: 'link', href: whole, title: null, auto: 1,
            children: [{ k: 'text', s: whole }],
          });
          i += whole.length;
          continue;
        }
      }
    }
    // Bare email: the previous character must not be one that could be
    // part of the address itself (or a '<' from a failed angle form).
    if (/[A-Za-z0-9.!#$%&'*+\-=?^_`{|}~]/.test(c) &&
        (i === 0 || !/[A-Za-z0-9.!#$%&'*+\-=?^_`{|}~@<]/.test(text[i - 1]))) {
      const email = matchEmail(text, i);
      if (email) {
        flush();
        out.push({
          k: 'link', href: 'mailto:' + email, title: null, auto: 1,
          children: [{ k: 'text', s: email }],
        });
        i += email.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// Apply linkify to every text node not inside a link or image.
function linkifyNodes(nodes) {
  // Leftover delimiter runs render as literal characters, so for the
  // autolink scan they belong to the surrounding text: merge each maximal
  // run of text and leftover delimiters into one string first (an email
  // candidate must be judged whole, underscores and all).
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.k === 'text' || nd.k === 'delim') {
      let j = i;
      let combined = '';
      while (j < nodes.length && (nodes[j].k === 'text' || nodes[j].k === 'delim')) {
        combined += nodes[j].k === 'text' ? nodes[j].s : nodes[j].ch.repeat(nodes[j].len);
        j++;
      }
      if (nd.nl) { i = j - 1; continue; }
      if (combined.includes('.') || combined.includes('@')) {
        const parts = linkifyText(combined);
        nodes.splice(i, j - i, ...parts);
        i += parts.length - 1;
      } else {
        i = j - 1;
      }
    } else if (nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') {
      linkifyNodes(nd.children);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += nd.s; break;
      case 'raw': out += nd.s; break;
      case 'code': out += nd.s; break;
      case 'soft': case 'hard': out += ' '; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'bracket': out += nd.s; break;
      case 'em': case 'strong': case 'del': case 'link': case 'img':
        out += plainText(nd.children);
        break;
      default: break;
    }
  }
  return out;
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += nd.raw ? nd.s : escapeText(nd.s); break;
      case 'raw': out += nd.s; break;
      case 'code': out += '<code>' + escapeCode(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'soft': out += '\n'; break;
      case 'hard': out += '<br>'; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'bracket': out += nd.s; break;
      case 'em': out += '<em>' + renderNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.children) + '</del>'; break;
      case 'link': {
        out += '<a href="' + escapeAttr(cleanUrl(nd.href)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += '>' + renderNodes(nd.children) + '</a>';
        break;
      }
      case 'img': {
        out += '<img src="' + escapeAttr(cleanUrl(nd.href)) + '" alt="' + escapeAttr(plainText(nd.children)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += '>';
        break;
      }
      default: break;
    }
  }
  return out;
}

function renderInline(text, defs) {
  const nodes = parseInlineNodes(text, defs);
  linkifyNodes(nodes);
  return renderNodes(nodes);
}

function renderBlocks(b, defs, out) {
  for (const child of b.children) renderBlock(child, defs, out);
}

function renderBlock(b, defs, out) {
  switch (b.t) {
    case 'doc':
      renderBlocks(b, defs, out);
      break;
    case 'quote':
      out.push('<blockquote>\n');
      renderBlocks(b, defs, out);
      out.push('</blockquote>\n');
      break;
    case 'para': {
      if (b.removed) break;
      out.push('<p>' + renderInline(b.text, defs) + '</p>\n');
      break;
    }
    case 'heading':
      out.push('<h' + b.level + '>' + renderInline(b.text, defs) + '</h' + b.level + '>\n');
      break;
    case 'code': {
      const literal = b.lines.length ? b.lines.join('\n') + '\n' : '';
      let cls = '';
      if (b.fenced && b.info) {
        const lang = unescapePunct(b.info).split(/\s+/)[0];
        if (lang) cls = ' class="language-' + escapeAttr(lang) + '"';
      }
      out.push('<pre><code' + cls + '>' + escapeCode(literal) + '</code></pre>\n');
      break;
    }
    case 'html': {
      out.push(b.lines.join('\n') + (b.trailingNL ? '\n' : ''));
      break;
    }
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'list': {
      if (b.bullet !== null && b.bullet !== undefined) out.push('<ul>\n');
      else out.push('<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n');
      for (const item of b.children) renderItem(item, b, defs, out);
      out.push(b.bullet ? '</ul>\n' : '</ol>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let c = 0; c < b.header.length; c++) {
        const a = b.aligns[c];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(b.header[c], defs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length) {
        out.push('<tbody>');
        const trs = [];
        for (const row of b.rows) {
          let tr = '<tr>\n';
          for (let c = 0; c < b.header.length; c++) {
            const a = b.aligns[c];
            const cell = c < row.length ? row[c] : '';
            tr += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell, defs) + '</td>\n';
          }
          tr += '</tr>';
          trs.push(tr);
        }
        out.push(trs.join('\n') + '\n</tbody>');
      }
      out.push('</table>\n');
      break;
    }
    default:
      break;
  }
}

const TASK_RE = /^\[([ xX])\] /;

function renderItem(item, list, defs, out) {
  const parts = [];
  let checkbox = null;
  const kids = item.children.filter(k => !(k.t === 'para' && k.removed));
  for (let idx = 0; idx < kids.length; idx++) {
    const kid = kids[idx];
    if (kid.t === 'para') {
      let text = kid.text;
      if (idx === 0) {
        const m = TASK_RE.exec(text);
        if (m) {
          checkbox = m[1] === ' '
            ? '<input disabled="" type="checkbox"> '
            : '<input checked="" disabled="" type="checkbox"> ';
          text = text.slice(m[0].length);
        }
      }
      if (list.tight) {
        parts.push(renderInline(text, defs));
      } else {
        // In a loose list the checkbox goes inside the paragraph.
        parts.push('<p>' + (checkbox || '') + renderInline(text, defs) + '</p>\n');
        checkbox = null;
      }
    } else {
      const sub = [];
      renderBlock(kid, defs, sub);
      parts.push(sub.join(''));
    }
  }
  out.push('<li>' + (checkbox || '') + parts.join('') + '</li>\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(src) {
  if (typeof src !== 'string') src = src == null ? '' : String(src);
  src = src.replace(/\r\n?/g, '\n');
  INLINE_STATE = { a: false, raw: false };
  const { root, defs } = parseBlocks(src);
  const out = [];
  renderBlock(root, defs, out);
  return out.join('');
}

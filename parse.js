// A dependency-free Markdown renderer whose output matches marked 18.1.3
// with default options (GFM on) byte for byte, built to run faster than
// marked itself.
//
// Pipeline (the same phases marked uses, so edge cases land identically):
//   1. block lexing over the whole document, collecting link definitions
//      and queueing inline work;
//   2. inline lexing of each queued text run, with a masked-delimiter
//      emphasis engine (delimiters are resolved against a masked copy of
//      the source whose link/code regions are neutralised);
//   3. rendering of the token tree.
// Where marked departs from CommonMark or GFM, marked's output wins.

// ---------------------------------------------------------------- helpers

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeRe = /[&<>"']/g;
const escapeTestRe = /[&<>"']/;
const escapeNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const escapeNoEncodeTestRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

// Escape HTML. With `encode`, every &<>"' is escaped; without, an & that
// already begins an entity is left alone.
function escapeHtml(s, encode) {
  if (encode) return escapeTestRe.test(s) ? s.replace(escapeRe, (c) => ESCAPES[c]) : s;
  return escapeNoEncodeTestRe.test(s) ? s.replace(escapeNoEncodeRe, (c) => ESCAPES[c]) : s;
}

const numericRefRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmpRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references in a text run.
function decodeNumericRefs(s) {
  if (!numericRefRe.test(s)) return s;
  return s.replace(numericRefOrAmpRe, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// encodeURI with %25 protection; null when encodeURI throws.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Remove the trailing run of `ch` (or of non-`ch` when invert is set).
function trimEndChars(s, ch, invert = false) {
  const n = s.length;
  if (n === 0) return '';
  let count = 0;
  while (count < n) {
    const c = s.charAt(n - count - 1);
    if (c === ch && !invert) count++;
    else if (c !== ch && invert) count++;
    else break;
  }
  return s.slice(0, n - count);
}

const blankLineRe = /^[ \t]*$/;

// Drop trailing blank lines of a raw block, unless there are at most two
// line endings after the last content line.
function trimTrailingBlankLines(src) {
  const lines = src.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && blankLineRe.test(lines[last])) last--;
  return lines.length - last <= 2 ? src : lines.slice(0, last + 1).join('\n');
}

// Normalise a link label: trim, collapse whitespace runs, case-fold.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index where a bracket balance first goes negative; -2 when left open;
// -1 when there are no brackets or the string is balanced.
function findClosingBracket(s, brackets) {
  if (s.indexOf(brackets[0]) === -1 && s.indexOf(brackets[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === brackets[0]) depth++;
    else if (s[i] === brackets[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces against 4-column tab stops; the line's first
// character sits at column `startCol`.
function expandTabs(line, startCol = 0) {
  if (!line.includes('\t')) return line;
  let col = startCol;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row into cells on unescaped pipes.
function splitCells(row, maxCells) {
  const marked = row.replace(/\|/g, (m, offset, whole) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && whole[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(/ \|/);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (maxCells !== undefined) {
    if (cells.length > maxCells) cells.splice(maxCells);
    else while (cells.length < maxCells) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ------------------------------------------------------------------ rules
// Token grammar for the block and inline passes (GFM flavour). These
// expressions define exactly where each construct starts and ends.

const TAG_NAMES =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const B = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  listFirstLine: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  text: /^[^\n]+/,
};

B.blockquote = new RegExp("^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+", "");
B.html = new RegExp("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i");
B.lheading = new RegExp("^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)", "");
B.paragraph = new RegExp("^([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)| *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)|[ \\t]+\\n)[^\\n]+)*)", "");
B.table = new RegExp("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)", "");

// Small shared patterns used by several tokenizers.
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  leadingSpaceTab: /^[ \t]+/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  endingNewline: /\n$/,
  notSpaceStart: /^\S*/,
};

const indentCache = [0, 1, 2, 3].map(() => ({}));
function indentRegex(indent, kind) {
  const n = Math.max(0, Math.min(3, indent - 1));
  const cache = indentCache[n];
  if (cache[kind]) return cache[kind];
  let re;
  switch (kind) {
    case 'nextBullet':
      re = new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
      break;
    case 'hr':
      re = new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
      break;
    case 'fencesBegin':
      re = new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`);
      break;
    case 'headingBegin':
      re = new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`);
      break;
    case 'htmlBegin':
      re = new RegExp(`^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
      break;
    case 'blockquoteBegin':
      re = new RegExp(`^ {0,${n}}>`);
      break;
  }
  cache[kind] = re;
  return re;
}

function listItemRegex(bullet) {
  return new RegExp(`^( {0,3}${bullet})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
}

// --------------------------------------------------------------- inline rules

const I = {
  escape: new RegExp("^\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])", ""),
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: new RegExp("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*", ""),
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  autolink: new RegExp("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>", ""),
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: new RegExp("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu"),
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: new RegExp("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))", ""),
};

// ---------------------------------------------------------- block tokenizers

function createLexer() {
  return {
    links: Object.create(null),
    inlineQueue: [],
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
  };
}

function queueInline(lex, src) {
  const tokens = [];
  lex.inlineQueue.push({ src, tokens });
  return tokens;
}

function tokSpace(src) {
  const m = B.newline.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
}

function tokIndentedCode(src) {
  const m = B.code.exec(src);
  if (!m) return;
  const raw = trimTrailingBlankLines(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(O.codeRemoveIndent, '') };
}

function compensateFenceIndent(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(O.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

function tokFences(src) {
  const m = B.fences.exec(src);
  if (!m) return;
  return {
    type: 'code',
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(I.anyPunctuation, '$1') : m[2],
    text: compensateFenceIndent(m[0], m[3] || ''),
  };
}

function tokHeading(lex, src) {
  const m = B.heading.exec(src);
  if (!m) return;
  let text = m[2].trim();
  if (O.endingHash.test(text)) {
    const stripped = trimEndChars(text, '#');
    if (!stripped || O.endingSpaceTabChar.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: trimEndChars(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(lex, text) };
}

function tokHr(src) {
  const m = B.hr.exec(src);
  if (m) return { type: 'hr', raw: trimEndChars(m[0], '\n') };
}

function tokBlockquote(lex, src) {
  const m = B.blockquote.exec(src);
  if (!m) return;
  let lines = trimEndChars(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    // A segment: lazy lines first, then marker lines, stopping at the
    // first non-marker line that follows a marker line.
    let foundMarker = false;
    const segment = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (O.blockquoteStart.test(lines[p])) {
        segment.push(lines[p]);
        foundMarker = true;
      } else if (!foundMarker) {
        segment.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const segRaw = segment.join('\n');
    const segText = segRaw
      .replace(O.blockquoteMarkerWhitespace, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${segRaw}` : segRaw;
    text = text ? `${text}\n${segText}` : segText;
    const savedTop = lex.state.top;
    lex.state.top = true;
    blockTokensInto(lex, segText, tokens, true);
    lex.state.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const rest = lines.join('\n');
      const mergedSrc = `${last.raw}\n${rest.replace(O.blockquoteSetextReplace2, '')}`;
      const merged = tokBlockquote(lex, mergedSrc);
      tokens[tokens.length - 1] = merged;
      const leftover = mergedSrc.substring(merged.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const rest = lines.join('\n');
      const mergedSrc = `${last.raw}\n${rest}`;
      const merged = tokList(lex, mergedSrc);
      tokens[tokens.length - 1] = merged;
      const extra =
        merged.raw.length > last.raw.length
          ? mergedSrc.slice(last.raw.length + 1, merged.raw.length).split('\n').length
          : 0;
      if (extra > 0) {
        const consumedText = lines.slice(0, extra).join('\n');
        raw = `${raw}\n${consumedText}`;
        text = `${text}\n${consumedText}`;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

function tokList(lex, src) {
  const first = B.listFirstLine.exec(src);
  if (!first) return;
  const original = src;
  let rest = src;
  const consumed = () => original.length - rest.length;
  let bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegex(bullet);
  let prevItemBlankEnd = false;
  let m;
  while (rest) {
    let itemEndsHere = false;
    let itemText = '';
    if (!(m = itemRe.exec(rest)) || B.hr.test(rest)) break;
    const itemStart = consumed();
    rest = rest.substring(m[0].length);
    const firstLine = m[2].endsWith('\n') ? m[2].slice(0, -1) : m[2];
    const bulletWidth = m[1].length;
    let content = firstLine.replace(O.leadingSpaceTab, (v) => expandTabs(v, bulletWidth));
    const nl0 = rest.indexOf('\n');
    let nextLine = nl0 === -1 ? rest : rest.slice(0, nl0);
    const blankItem = !content.trim();
    let indent;
    if (blankItem) {
      indent = bulletWidth + 1;
    } else {
      indent = content.search(O.nonSpaceChar);
      if (indent > 4) indent = 1;
      itemText = content.slice(indent);
      indent += bulletWidth;
    }
    if (blankItem && blankLineRe.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      itemEndsHere = true;
    }
    if (!itemEndsHere) {
      const nextBullet = indentRegex(indent, 'nextBullet');
      const hrAtIndent = indentRegex(indent, 'hr');
      const fencesAtIndent = indentRegex(indent, 'fencesBegin');
      const headingAtIndent = indentRegex(indent, 'headingBegin');
      const htmlAtIndent = indentRegex(indent, 'htmlBegin');
      const quoteAtIndent = indentRegex(indent, 'blockquoteBegin');
      let lineBlank = blankItem;
      while (rest) {
        const nl = rest.indexOf('\n');
        const line = nl === -1 ? rest : rest.slice(0, nl);
        nextLine = line;
        const firstCode = line.charCodeAt(0);
        const expanded =
          firstCode === 32 || firstCode === 9 ? line.replace(O.leadingSpaceTab, (v) => expandTabs(v)) : line;
        if (
          fencesAtIndent.test(line) ||
          headingAtIndent.test(line) ||
          htmlAtIndent.test(line) ||
          quoteAtIndent.test(line) ||
          nextBullet.test(line) ||
          hrAtIndent.test(line)
        ) {
          break;
        }
        if (expanded.search(O.nonSpaceChar) >= indent || !line.trim()) {
          itemText += `\n${expanded.slice(indent)}`;
        } else {
          if (
            lineBlank ||
            (content.includes('\t') ? content.replace(/\t/g, '    ') : content).search(O.nonSpaceChar) >= 4 ||
            fencesAtIndent.test(content) ||
            headingAtIndent.test(content) ||
            htmlAtIndent.test(content) ||
            hrAtIndent.test(content)
          ) {
            break;
          }
          const asSetext =
            /^ {0,3}(?:=+|-+) *$/.test(line) && B.lheading.test(`${content}\n${line}`)
              ? `    ${expanded.replace(/^ {0,3}/, '')}`
              : line;
          itemText += `\n${asSetext}`;
        }
        lineBlank = !line.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = original.slice(itemStart, consumed());
    if (!list.loose) {
      if (prevItemBlankEnd) list.loose = true;
      else if (O.doubleBlankLine.test(itemRaw)) prevItemBlankEnd = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: O.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return;
  }
  list.raw = original.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    lex.state.top = false;
    item.tokens = blockTokensInto(lex, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => O.anyLine.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
      item.text = item.text.replace(O.listReplaceTask, '');
      firstTok.raw = firstTok.raw.replace(O.listReplaceTask, '');
      firstTok.text = firstTok.text.replace(O.listReplaceTask, '');
      for (let g = lex.inlineQueue.length - 1; g >= 0; g--) {
        if (O.listIsTask.test(lex.inlineQueue[g].src)) {
          lex.inlineQueue[g].src = lex.inlineQueue[g].src.replace(O.listReplaceTask, '');
          break;
        }
      }
      const checkboxMatch = O.listTaskCheckbox.exec(item.raw);
      if (checkboxMatch) {
        const checkbox = { type: 'checkbox', raw: `${checkboxMatch[0]} `, checked: checkboxMatch[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (
            item.tokens[0] &&
            (item.tokens[0].type === 'paragraph' || item.tokens[0].type === 'text') &&
            item.tokens[0].tokens
          ) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            item.tokens[0].text = checkbox.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

function tokHtml(src) {
  const m = B.html.exec(src);
  if (!m) return;
  const raw = trimTrailingBlankLines(m[0]);
  return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
}

function tokDef(src) {
  const m = B.def.exec(src);
  if (!m) return;
  if (!O.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return;
  return {
    type: 'def',
    tag: normalizeLabel(m[1]),
    raw: trimEndChars(m[0], '\n'),
    href: m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(I.anyPunctuation, '$1') : '',
    title: m[3] ? m[3].substring(1, m[3].length - 1).replace(I.anyPunctuation, '$1') : m[3],
  };
}

function tokTable(lex, src) {
  const m = B.table.exec(src);
  if (!m || !O.tableDelimiter.test(m[2])) return;
  const headerCells = splitCells(m[1]);
  const aligns = m[2].replace(O.tableAlignChars, '').split('|');
  const rowLines = m[3] && m[3].trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  if (headerCells.length !== aligns.length) return;
  const table = { type: 'table', raw: trimEndChars(m[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of aligns) {
    table.align.push(
      O.tableAlignRight.test(cell) ? 'right' : O.tableAlignCenter.test(cell) ? 'center' : O.tableAlignLeft.test(cell) ? 'left' : null,
    );
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(lex, headerCells[i]), header: true, align: table.align[i] });
  }
  for (const rowLine of rowLines) {
    table.rows.push(
      splitCells(rowLine, table.header.length).map((cell, j) => ({
        text: cell,
        tokens: queueInline(lex, cell),
        header: false,
        align: table.align[j],
      })),
    );
  }
  return table;
}

function tokLheading(lex, src) {
  const m = B.lheading.exec(src);
  if (!m) return;
  const text = m[1].trim();
  return { type: 'heading', raw: trimEndChars(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(lex, text) };
}

function tokParagraph(lex, src) {
  const m = B.paragraph.exec(src);
  if (!m) return;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(lex, text) };
}

function tokBlockText(lex, src) {
  const m = B.text.exec(src);
  if (m) return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(lex, m[0]) };
}

// The block pass. `clipped` is set when the caller (a blockquote segment)
// needs a paragraph that continues the previous segment's paragraph to be
// merged into it instead of starting a new token.
function blockTokensInto(lex, src, tokens, clipped = false) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error(`Infinite loop on byte: ${src.charCodeAt(0)}`);
    let tok;
    if ((tok = tokSpace(src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((tok = tokIndentedCode(src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += `${prev.raw.endsWith('\n') ? '' : '\n'}${tok.raw}`;
        prev.text += `\n${tok.text}`;
        lex.inlineQueue[lex.inlineQueue.length - 1].src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = tokFences(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokHeading(lex, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokHr(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokBlockquote(lex, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokList(lex, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokHtml(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokDef(src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += `${prev.raw.endsWith('\n') ? '' : '\n'}${tok.raw}`;
        prev.text += `\n${tok.raw}`;
        lex.inlineQueue[lex.inlineQueue.length - 1].src = prev.text;
      } else {
        if (!lex.links[tok.tag]) lex.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tokTable(lex, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokLheading(lex, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (lex.state.top && (tok = tokParagraph(lex, src))) {
      const prev = tokens[tokens.length - 1];
      if (clipped && prev && prev.type === 'paragraph') {
        prev.raw += `${prev.raw.endsWith('\n') ? '' : '\n'}${tok.raw}`;
        prev.text += `\n${tok.text}`;
        lex.inlineQueue.pop();
        lex.inlineQueue[lex.inlineQueue.length - 1].src = prev.text;
      } else {
        tokens.push(tok);
      }
      clipped = false;
      src = src.substring(tok.raw.length);
      continue;
    }
    if ((tok = tokBlockText(lex, src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += `${prev.raw.endsWith('\n') ? '' : '\n'}${tok.raw}`;
        prev.text += `\n${tok.text}`;
        lex.inlineQueue.pop();
        lex.inlineQueue[lex.inlineQueue.length - 1].src = prev.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }
    throw new Error(`Infinite loop on byte: ${src.charCodeAt(0)}`);
  }
  lex.state.top = true;
  return tokens;
}

// --------------------------------------------------------- inline tokenizers

function tokEscape(src) {
  const m = I.escape.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
}

function tokTag(lex, src) {
  const m = I.tag.exec(src);
  if (!m) return;
  if (!lex.state.inLink && O.startATag.test(m[0])) lex.state.inLink = true;
  else if (lex.state.inLink && O.endATag.test(m[0])) lex.state.inLink = false;
  if (!lex.state.inRawBlock && O.startPreScriptTag.test(m[0])) lex.state.inRawBlock = true;
  else if (lex.state.inRawBlock && O.endPreScriptTag.test(m[0])) lex.state.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: lex.state.inLink, inRawBlock: lex.state.inRawBlock, block: false, text: m[0] };
}

// Decides whether the `]` ending a would-be link label really closes it:
// a tag or autolink inside the label whose raw text runs past the label's
// end means the label continues further.
function labelContainsTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    const c = label.charAt(i);
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') {
      const code = I.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (c !== '<') continue;
    const rest = src.slice(offset + i);
    const tag = I.tag.exec(rest) || I.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

function outputLink(lex, cap, link, raw) {
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = lex.state.inLink;
  const savedEmitted = lex.state.linkEmitted;
  const savedRaw = lex.state.inRawBlock;
  lex.state.inLink = true;
  lex.state.linkEmitted = false;
  const tokens = inlineTokensInto(lex, text, []);
  const emitted = lex.state.linkEmitted;
  lex.state.linkEmitted = savedEmitted;
  lex.state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      lex.state.inRawBlock = savedRaw;
      return;
    }
    lex.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: link.href, title: link.title || null, text, tokens };
}

function tokLink(lex, src) {
  if (lex.state.linkParenPossible === false) return;
  let m = I.link.exec(src);
  if (!m) return;
  const offset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelContainsTag(src, m[1], offset)) return;
  let href = m[2].trim();
  if (O.startAngleBracket.test(href)) {
    if (!O.endAngleBracket.test(href)) return;
    const stripped = trimEndChars(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return;
  } else {
    const idx = findClosingBracket(m[2], '()');
    if (idx === -2) return;
    if (idx > -1) {
      const end = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + idx;
      m = [...m];
      m[2] = m[2].substring(0, idx);
      m[0] = m[0].substring(0, end).trim();
      m[3] = '';
    }
  }
  const trimmedEnd = trimEndChars(m[0].slice(0, -1), '\\');
  if ((m[0].length - trimmedEnd.length) % 2 === 0) return;
  let outHref = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  outHref = outHref.trim();
  if (O.startAngleBracket.test(outHref)) outHref = outHref.slice(1, -1);
  return outputLink(
    lex,
    m,
    {
      href: outHref && outHref.replace(I.anyPunctuation, '$1'),
      title: title && title.replace(I.anyPunctuation, '$1'),
    },
    m[0],
  );
}

function tokReflink(lex, src) {
  const m = I.reflink.exec(src) || I.nolink.exec(src);
  if (!m) return;
  const offset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelContainsTag(src, m[1], offset)) return;
  const link = lex.links[normalizeLabel(m[2] || m[1])];
  if (!link) {
    const first = m[0].charAt(0);
    return { type: 'text', raw: first, text: first };
  }
  return outputLink(lex, m, link, m[0]);
}

// Last index at which each emphasis delimiter could still close, found by
// scanning the masked text: a run whose preceding character is not
// whitespace can close. Scanning backwards lets us stop as soon as the
// last run of every delimiter kind has been found.
function scanMaskInfo(masked) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  let found = 0;
  let i = masked.length - 1;
  while (i >= 0 && found < 3) {
    const c = masked.charAt(i);
    if (c !== '*' && c !== '_' && c !== '~') {
      i--;
      continue;
    }
    let j = i;
    while (j >= 0 && masked.charAt(j) === c) j--;
    const start = j + 1;
    const already = c === '~' ? lastDel !== -1 : lastEm[c] !== -1;
    if (!already) {
      const prev = start === 0 ? '\n' : masked.charAt(start - 1);
      if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
        if (c === '~') lastDel = start;
        else lastEm[c] = start;
        found++;
      }
    }
    i = j;
  }
  return { lastEm, lastDel };
}

function tokEmStrong(lex, src, masked, maskInfo, prevChar) {
  const open = I.emStrongLDelim.exec(src);
  if (!open || (!open[1] && !open[2] && !open[3] && !open[4])) return;
  const delim = open[0].charAt(0);
  const sameChar = prevChar === delim;
  const pos = masked.length - src.length;
  let runStart = pos;
  while (runStart > 0 && masked.charAt(runStart - 1) === delim) runStart--;
  let charBefore = '';
  if (runStart > 0) {
    const points = [...masked.slice(Math.max(0, runStart - 2), runStart)];
    charBefore = points[points.length - 1];
  }
  const beforeIsDelimOrPunct = charBefore === '*' || charBefore === '_' || !!I.punctuation.exec(charBefore);
  if (runStart < pos) prevChar = charBefore;
  const prevIsPunct = runStart < pos ? beforeIsDelimOrPunct : !!I.punctuation.exec(prevChar);
  if (open[4] && prevChar.match(O.unicodeAlphaNumeric)) return;
  const followedByPunct = open[1] || open[3] || '';
  if (followedByPunct && prevChar && !prevIsPunct) return;
  const openerLen = [...open[0]].length - 1;
  let remaining = openerLen;
  let threesLeftover = 0;
  const runTotal = pos - runStart + openerLen;
  const middle = !!charBefore.trim() && (!!followedByPunct || (delim === '*' && !beforeIsDelimOrPunct));
  if (delim !== '*' && delim !== '_') return;
  const rDelim = delim === '*' ? I.emStrongRDelimAst : I.emStrongRDelimUnd;
  const lastCloser = maskInfo.lastEm[delim];
  const afterOpener = pos + openerLen;
  if (lastCloser < afterOpener) return;
  const tail = masked.slice(afterOpener);
  const maxIndex = lastCloser - afterOpener;
  rDelim.lastIndex = 0;
  let m;
  while ((m = rDelim.exec(tail)) !== null && !(m.index > maxIndex)) {
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    let len = [...g].length;
    if (m[3] || m[4]) {
      remaining += len;
      continue;
    }
    if (m[5] || m[6] || middle) {
      if (sameChar && (m[5] || m[6])) break;
      if (runTotal % 3 && !((runTotal + len) % 3)) {
        threesLeftover += len;
        continue;
      }
    }
    remaining -= len;
    if (remaining > 0) continue;
    len = Math.min(len, len + remaining + threesLeftover);
    const firstCharLen = [...m[0]][0].length;
    const raw = src.slice(0, openerLen + m.index + firstCharLen + len);
    if (Math.min(openerLen, len) % 2) {
      const content = raw.slice(1, -1);
      return { type: 'em', raw, text: content, tokens: inlineTokensInto(lex, content, []) };
    }
    const content = raw.slice(2, -2);
    return { type: 'strong', raw, text: content, tokens: inlineTokensInto(lex, content, []) };
  }
}

function tokCodespan(src) {
  const m = I.code.exec(src);
  if (!m) return;
  let text = m[2].replace(/\n/g, ' ');
  const hasNonSpace = O.nonSpaceChar.test(text);
  const hasStartSpace = O.startingSpaceChar.test(text);
  const hasEndSpace = O.endingSpaceChar.test(text);
  if (hasNonSpace && hasStartSpace && hasEndSpace) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
}

function tokBr(src) {
  const m = I.br.exec(src);
  if (m) return { type: 'br', raw: m[0] };
}

function tokDel(lex, src, masked, maskInfo, prevChar) {
  const open = I.delLDelim.exec(src);
  if (!open) return;
  if ((open[1] || '') && prevChar && !I.punctuation.exec(prevChar)) return;
  const openerLen = [...open[0]].length - 1;
  let remaining = openerLen;
  const lastCloser = maskInfo.lastDel;
  const afterOpener = masked.length - src.length + openerLen;
  if (lastCloser < afterOpener) return;
  const tail = masked.slice(afterOpener);
  const maxIndex = lastCloser - afterOpener;
  I.delRDelim.lastIndex = 0;
  let m;
  while ((m = I.delRDelim.exec(tail)) !== null && !(m.index > maxIndex)) {
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    let len = [...g].length;
    if (len !== openerLen) continue;
    if (m[3] || m[4]) {
      remaining += len;
      continue;
    }
    remaining -= len;
    if (remaining > 0) continue;
    len = Math.min(len, len + remaining);
    const firstCharLen = [...m[0]][0].length;
    const raw = src.slice(0, openerLen + m.index + firstCharLen + len);
    const content = raw.slice(openerLen, -openerLen);
    return { type: 'del', raw, text: content, tokens: inlineTokensInto(lex, content, []) };
  }
}

function tokAutolink(src) {
  const m = I.autolink.exec(src);
  if (!m) return;
  let text, href;
  if (m[2] === '@') {
    text = m[1];
    href = `mailto:${text}`;
  } else {
    text = m[1];
    href = m[1];
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokUrl(src) {
  const m = I.url.exec(src);
  if (!m) return;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = `mailto:${text}`;
  } else {
    let prev;
    let cur = m;
    do {
      prev = cur[0];
      cur = [...cur];
      cur[0] = I.backpedal.exec(cur[0])?.[0] ?? '';
    } while (prev !== cur[0]);
    text = cur[0];
    href = m[1] === 'www.' ? `http://${cur[0]}` : cur[0];
  }
  return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokInlineText(lex, src) {
  const m = I.text.exec(src);
  if (!m) return;
  const inRaw = lex.state.inRawBlock;
  return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeNumericRefs(m[0]), escaped: inRaw };
}

// ------------------------------------------------------------- masking pass

// True when `text` (a would-be link label) itself contains a complete
// link: either an inline link in a skippable region, or a reference link
// whose label is known and whose own label contains no link.
function linkInText(lex, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(I.blockSkip)) {
    if (I.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(I.reflinkSearch)) {
    const s = match[0];
    const open = s.lastIndexOf('[');
    const isLink = !(s.charAt(0) === '!' || !Object.hasOwn(lex.links, normalizeLabel(s.slice(open + 1, -1))));
    if (isLink && !(open > 1 && linkInText(lex, s.slice(1, open - 1)))) return true;
  }
  return false;
}

function maskSrc(lex, src) {
  let masked = src;
  if (src.includes('[')) {
    const collapseRef = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(lex.links, normalizeLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (linkInText(lex, inner)) {
          return `[${inner.replace(I.reflinkSearch, collapseRef)}][${'a'.repeat(match.length - open - 2)}]`;
        }
      }
      return `[${'a'.repeat(match.length - 2)}]`;
    };
    masked = masked.replace(I.reflinkSearch, collapseRef);
  }
  // The punctuation pass can only change something when a backslash or a
  // backtick is present; the block-skip pass additionally needs '[' or '<'.
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(I.anyPunctuationOutsideCode, (match, codeRun, punct) => {
      if (punct) return '+'.repeat(match.length);
      if (codeRun) return codeRun + match.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun;
      return match;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(I.blockSkip, (match, g1, g2) => {
      const keep = g2 ? g2.length : 0;
      return `${match.slice(0, keep)}[${'a'.repeat(match.length - keep - 2)}]`;
    });
  }
  return masked;
}

// The inline pass. Link targets with balanced parentheses only matter
// when the text can contain one, so the paren check is scoped to the
// current call.
function inlineTokensInto(lex, src, tokens) {
  const savedParen = lex.state.linkParenPossible;
  lex.state.linkParenPossible = savedParen && src.includes(')');
  try {
    return inlineTokensInner(lex, src, tokens);
  } finally {
    lex.state.linkParenPossible = savedParen;
  }
}

function inlineTokensInner(lex, src, tokens) {
  let masked = src;
  let maskInfo = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = maskSrc(lex, src);
    maskInfo = scanMaskInfo(masked);
  }
  let prevChar = '';
  let keepPrevChar = false;
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error(`Infinite loop on byte: ${src.charCodeAt(0)}`);
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    // Every tokenizer except text/url is anchored to a distinctive first
    // character, so most attempts can be skipped by dispatching on it.
    // The relative order of the attempts that remain is marked's order.
    const c = src.charCodeAt(0);
    let tok;
    if (c === 92) {
      // backslash
      if ((tok = tokEscape(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = tokBr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 60) {
      // '<'
      if ((tok = tokTag(lex, src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = tokAutolink(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 91 || c === 33) {
      // '[' or '!'
      if ((tok = tokLink(lex, src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = tokReflink(lex, src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.type === 'text' && prev && prev.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
    } else if (c === 42 || c === 95) {
      // '*' or '_'
      if ((tok = tokEmStrong(lex, src, masked, maskInfo, prevChar))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 96) {
      // '`'
      if ((tok = tokCodespan(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 32) {
      // ' '
      if ((tok = tokBr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 126) {
      // '~'
      if ((tok = tokDel(lex, src, masked, maskInfo, prevChar))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    }
    if (
      !lex.state.inLink &&
      ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45) &&
      (tok = tokUrl(src))
    ) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokInlineText(lex, src))) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      keepPrevChar = true;
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += tok.raw;
        prev.text += tok.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error(`Infinite loop on byte: ${src.charCodeAt(0)}`);
  }
  return tokens;
}

// ----------------------------------------------------------------- renderer

function renderTextToken(token, textMode) {
  if (textMode) {
    if (token.tokens) return renderInlineTokens(token.tokens, true);
    return token.text;
  }
  if (token.tokens) return renderInlineTokens(token.tokens, false);
  if ('escaped' in token && token.escaped) return token.text;
  return escapeHtml(token.text);
}

function renderInlineTokens(tokens, textMode) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
        out += renderTextToken(token, textMode);
        break;
      case 'html':
        out += textMode ? '' : token.text;
        break;
      case 'link': {
        if (textMode) {
          out += renderInlineTokens(token.tokens, true);
          break;
        }
        const content = token.autolink ? escapeHtml(token.text, true) : renderInlineTokens(token.tokens, false);
        const href = cleanUrl(token.href);
        if (href === null) {
          out += content;
          break;
        }
        out += `<a href="${escapeHtml(href, !!token.autolink)}"`;
        if (token.title) out += ` title="${escapeHtml(token.title)}"`;
        out += `>${content}</a>`;
        break;
      }
      case 'image': {
        const alt = token.tokens ? renderInlineTokens(token.tokens, true) : token.text;
        if (textMode) {
          out += alt;
          break;
        }
        const href = cleanUrl(token.href);
        if (href === null) {
          out += escapeHtml(alt);
          break;
        }
        out += `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
        if (token.title) out += ` title="${escapeHtml(token.title)}"`;
        out += '>';
        break;
      }
      case 'strong':
        out += textMode ? renderInlineTokens(token.tokens, true) : `<strong>${renderInlineTokens(token.tokens, false)}</strong>`;
        break;
      case 'em':
        out += textMode ? renderInlineTokens(token.tokens, true) : `<em>${renderInlineTokens(token.tokens, false)}</em>`;
        break;
      case 'codespan':
        out += textMode ? token.text : `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      case 'br':
        out += textMode ? '' : '<br>';
        break;
      case 'del':
        out += textMode ? renderInlineTokens(token.tokens, true) : `<del>${renderInlineTokens(token.tokens, false)}</del>`;
        break;
      case 'checkbox':
        out += textMode ? token.raw : `<input ${token.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'text':
        out += renderTextToken(token, textMode);
        break;
    }
  }
  return out;
}

function renderTableRow(cellsHtml) {
  return `<tr>\n${cellsHtml}</tr>\n`;
}

function renderBlockTokens(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'code': {
        const langWord = (token.lang || '').match(/^\S*/)?.[0];
        const content = token.text ? `${token.text.replace(/\n$/, '')}\n` : '';
        if (langWord) {
          out += `<pre><code class="language-${escapeHtml(langWord)}">${escapeHtml(content, true)}</code></pre>\n`;
        } else {
          out += `<pre><code>${escapeHtml(content, true)}</code></pre>\n`;
        }
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlockTokens(token.tokens)}</blockquote>\n`;
        break;
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInlineTokens(token.tokens, false)}</h${token.depth}>\n`;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'list': {
        const tag = token.ordered ? 'ol' : 'ul';
        const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
        let body = '';
        for (const item of token.items) body += `<li>${renderBlockTokens(item.tokens)}</li>\n`;
        out += `<${tag}${startAttr}>\n${body}</${tag}>\n`;
        break;
      }
      case 'paragraph':
        out += `<p>${renderInlineTokens(token.tokens, false)}</p>\n`;
        break;
      case 'table': {
        let headerCells = '';
        for (const cell of token.header) {
          headerCells += cell.align
            ? `<th align="${cell.align}">${renderInlineTokens(cell.tokens, false)}</th>\n`
            : `<th>${renderInlineTokens(cell.tokens, false)}</th>\n`;
        }
        let body = '';
        for (const row of token.rows) {
          let cells = '';
          for (const cell of row) {
            cells += cell.align
              ? `<td align="${cell.align}">${renderInlineTokens(cell.tokens, false)}</td>\n`
              : `<td>${renderInlineTokens(cell.tokens, false)}</td>\n`;
          }
          body += renderTableRow(cells);
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n${renderTableRow(headerCells)}</thead>\n${body}</table>\n`;
        break;
      }
      case 'text':
        out += token.tokens ? renderInlineTokens(token.tokens, false) : token.escaped ? token.text : escapeHtml(token.text);
        break;
      case 'checkbox':
        out += `<input ${token.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
    }
  }
  return out;
}

// Renders a Markdown document to HTML with output identical to marked's
// default (GFM) configuration.
export function parse(markdown) {
  const lex = createLexer();
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const tokens = blockTokensInto(lex, src, []);
  for (const item of lex.inlineQueue) {
    lex.state.inRawBlock = false;
    inlineTokensInto(lex, item.src, item.tokens);
  }
  lex.inlineQueue.length = 0;
  return renderBlockTokens(tokens);
}

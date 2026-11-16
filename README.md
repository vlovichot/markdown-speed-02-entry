# markdown-render-speed-02

A from-scratch Markdown renderer for the make.fun
`markdown-render-speed-02` competition: a drop-in replacement for the
marked renderer (marked 18.1.3, default options — GFM on, `breaks`
off, `pedantic` off) that reproduces its HTML output byte for byte and
is ranked by CPU time among correct entries.

## Layout

- `main.ts` — the entry driver. Reads `cases.json` (an array of
  `{id, markdown}`) from `MAKEFUN_INPUT_DIR` (default `/input`),
  renders every case, and writes the HTML strings, in order, as a
  JSON array to `html.json` in `MAKEFUN_OUTPUT_DIR` (default
  `/output`). Node 22 runs it directly; it uses only erasable
  TypeScript syntax and the standard library.
- `parse.js` — the renderer itself, a dependency-free ES module
  exporting `parse(markdown) -> html`.

## How it works

The renderer is an original two-pass design written for this entry:

1. **Block pass** — a line-oriented container parser. Each input line
   is matched against the stack of open blocks (block quotes and list
   items consume their prefixes through a column-aware cursor that
   expands tabs the way the reference lexer does), then new blocks
   may start (headings, fences, HTML blocks, tables, lists), then the
   line feeds the open leaf block (paragraph, code, HTML, table).
   List looseness, lazy continuation lines, setext underlines, link
   reference definitions and the reference renderer's container-text
   quirks are reproduced at this level.
2. **Inline pass** — each block's text is scanned once into nodes:
   escapes, code spans, raw HTML tags, angle autolinks, emphasis and
   strikethrough, links/images (inline, full/collapsed reference and
   shortcut forms), and GFM text autolinking (scheme/`www.`/email)
   applied to the resulting text runs. Emphasis uses a port of the
   reference tokenizer's masked-delimiter engine (the text is masked
   — reference links collapsed, punctuation outside code spans
   neutralised, skippable blocks bracketed — and closer candidates
   are evaluated against the mask), because that is what decides the
   many delimiter cases where the simpler flanking rules disagree.
   Bracket handling simulates the reference link label grammar
   (nested bracket groups, escapes, code-span alternatives) to decide
   exactly which `]` can close a link, and a bracket that will not
   form falls back to the same masked emphasis attempts the reference
   makes in its main pass.

Escaping, URL cleaning (percent-encoding), entity handling and
attribute quoting follow the reference renderer's rules throughout,
so the output matches marked byte for byte on the full practice set
(680 CommonMark/GFM spec cases and 40 generated documents,
720/720 locally, verified with the kit's `grade-local`).

## Run / test

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output \
  node main.ts
```

Local grading with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . \
  --bot /path/to/this/repo --driver process
```

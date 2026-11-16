# markdown-render-speed-02 — entry by wlowichot

![bounty](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/vlovichot/markdown-speed-02-entry/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/vlovichot/markdown-speed-02-entry/reward.svg)

A from-scratch Markdown-to-HTML renderer whose output is byte-identical to
[marked](https://marked.js.org/) (v18, default GFM options) on every input,
written for the [markdown-render-speed-02](https://make.fun/bounties/markdown-render-speed-02)
bounty on make.fun, where correct entries are ranked by CPU time.

## Layout

- `main.ts` — the driver: reads `{ id, markdown }` cases from
  `MAKEFUN_INPUT_DIR` (default `/input`), renders each with `parse()`, and
  writes the HTML strings to `MAKEFUN_OUTPUT_DIR` (default `/output`) as
  `html.json`.
- `parse.js` — the renderer itself. Pure Node standard library, no
  dependencies, no network.

## How it works

The renderer mirrors marked's two-phase design, because the goal is not
"a correct Markdown renderer" but "*marked's* output, byte for byte":

1. **Block pass.** A tokenizer chain (space, indented code, fences,
   headings, rules, blockquotes, lists, HTML blocks, link reference
   definitions, tables, setext headings, paragraphs, text) consumes the
   document. Blockquotes and list items recurse with the same machinery,
   reproducing marked's container quirks: list looseness detection, lazy
   paragraph continuation, tab expansion by column, the segmented re-lexing
   of blockquotes whose inner content ends in a blockquote or list, and
   link definitions collected along the way. Inline text is only *queued*
   during this pass.
2. **Inline pass.** Each queued text run is scanned for escapes, raw HTML,
   code spans, links and images (inline, full/collapsed/shortcut
   reference forms), autolinks and GFM text autolinks. Emphasis and
   strikethrough are resolved the way marked resolves them: the source is
   first *masked* (reference-link labels collapsed, punctuation outside
   code spans neutralised, link/code regions wrapped), the last possible
   closer for each delimiter is located on the masked text, and delimiter
   runs are then matched with marked's own left/right-delimiter accounting
   (including the rule-of-three behaviour).
3. **Rendering.** The token tree is walked to HTML with marked's exact
   escaping rules (including its entity-preserving no-encode mode and its
   URL cleaning).

## Running

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`package.json` declares `"type": "module"` so `parse.js` can be imported
directly; `main.ts` is plain JavaScript-compatible TypeScript that Node's
type stripping runs as-is.

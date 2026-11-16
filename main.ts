// markdown-render-speed-02 entry driver.
//
// Reads every case from cases.json in the input directory, renders each
// markdown string with parse() from ./parse.js and writes the HTML strings,
// in the cases' order, as a JSON array to html.json in the output directory.
// Outside the sandbox the input/output directories come from the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment variables.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as Case[];
  const out: string[] = new Array<string>(cases.length);
  for (let i = 0; i < cases.length; i++) {
    out[i] = parse(cases[i].markdown);
  }
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
}

main();

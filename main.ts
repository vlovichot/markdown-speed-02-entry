// Entry point for the markdown-render-speed-02 benchmark.
//
// Reads an array of { id, markdown } cases from the input directory,
// renders each one with the renderer in ./parse.js, and writes the HTML
// strings (same order as the input) to the output directory.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8"));
const html = cases.map((c) => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));

// Fails when a t("…") key used in the dashboard has no French translation (or a dotted key has no English text).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const src = new URL("../src/", import.meta.url).pathname;
const en = JSON.parse(readFileSync(join(src, "locales/en.json"), "utf8"));
const fr = JSON.parse(readFileSync(join(src, "locales/fr.json"), "utf8"));

const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) && files.push(join(d, f))));
walk(src);

const used = new Map();
for (const f of files) {
  const code = readFileSync(f, "utf8");
  for (const m of code.matchAll(/\bt\(\s*("(?:[^"\\]|\\.)*")/g)) used.set(JSON.parse(m[1]), f.slice(src.length));
}
// Label maps translated at render time with t(map[key]): their English values must be translated too.
const LABEL_SOURCES = [
  ["lib/labels.ts", /: "([^"]+)",/g],
  ["pages/Deployment.tsx", /const PHASE_LABELS[^;]*;/, /"([A-Z][^"]+)"/g],
  ["pages/Referrals.tsx", /const METHOD_LABEL[^;]*;/, /"([A-Z][^"]+)"/g],
  ["pages/Admin.tsx", /const SECTIONS = \[[\s\S]*?\] as const;/, /"([A-Z][^"]+)"/g],
  ["pages/NewProject.tsx", /const ENGINES[\s\S]*?\n\];/, /hint: "([^"]+)"/g],
  ["pages/Landing.tsx", /const FEATURES[\s\S]*?\] as const;/, /(?:title|text): "([^"]+)"/g],
  ["pages/Landing.tsx", /const STEPS[\s\S]*?\] as const;/, /"([A-Z][^"]+)"/g],
];
for (const [file, a, b] of LABEL_SOURCES) {
  let code = readFileSync(join(src, file), "utf8");
  const values = b ? code.match(a)?.[0] ?? "" : code;
  for (const m of values.matchAll(b ?? a)) used.set(m[1], file);
}

const problems = [];
for (const [key, file] of used) {
  const natural = !/^[a-z]+(\.[a-zA-Z0-9_]+)+$/.test(key);
  if (!natural && !(key in en)) problems.push(`missing English text for "${key}" (${file})`);
  if (!(key in fr)) problems.push(`missing French translation for "${key}" (${file})`);
}
for (const [key, value] of Object.entries(fr)) {
  const vars = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(",");
  const source = key in en ? en[key] : key;
  if (vars(source) !== vars(value)) problems.push(`interpolation mismatch in "${key}"`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} i18n problem(s)`);
  process.exit(1);
}
console.log(`i18n: ${used.size} keys used, all translated in French`);

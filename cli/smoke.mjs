// Smoke run: build the index over the real skill roots and show timing plus
// the top-3 results for a few fixed queries. Usage: node cli/smoke.mjs
import { defaultRoots, discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";

const roots = defaultRoots();

const t0 = performance.now();
const { skills, skipped } = discoverSkills(roots);
const index = buildIndex(skills);
const buildMs = performance.now() - t0;

console.log(`skills found: ${skills.length}`);
console.log(`skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.path} (${s.reason})`);
console.log(`roots: ${roots.length}`);
for (const r of roots) console.log(`  - ${r}`);
console.log(`index build: ${buildMs.toFixed(1)} ms`);

const QUERIES = [
  "review a commercial contract",
  "bug bounty report",
  "resume for a software job",
  "gsap scroll animation",
  "жалоба в ФАС по тендеру",
];

for (const q of QUERIES) {
  const top = search(index, q, { limit: 3 });
  console.log(`\nQ: ${q}`);
  if (top.length === 0) {
    console.log("  (nothing found)");
    continue;
  }
  top.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name}  score=${r.score.toFixed(3)}`);
    console.log(`     ${r.why}`);
  });
}

// Latency measurement (M4): hint formation along the SAME path the plugin uses
// (plugin/hint.mjs createContextHook), on the held-out set measure/heldout.jsonl.
//
// Protocol (fixed before the run):
//   1. one factory call (config load) — the plugin does this once per process;
//   2. ONE cold first invocation of a fresh hook — includes index discovery/build;
//   3. an explicit timed discover+build (index build reference number);
//   4. a warm hook over the pre-built index, index warmed once, then the 60
//      held-out queries; for each query both
//        - search only  (core search, limit=10 — the plugin's candidate pool) and
//        - the full path (search + deny/allow + «зачем» + block building);
//   5. p50/p95/max (nearest-rank percentile) over the 60 samples.
//
// env is passed as {} so the hint is ON regardless of the shell environment;
// config comes from the real plugin/skill-mcp.config.json.
//
// Usage: node measure/latency.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";
import { createContextHook } from "../plugin/hint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const queries = fs
  .readFileSync(path.join(HERE, "heldout.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const now = () => performance.now();
const ms = (v) => `${v.toFixed(2)} ms`;

function eventFor(text) {
  return {
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    agent: "",
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: sum / (sorted.length || 1),
  };
}

// 2. cold first call — real plugin path, index built inside on first use.
const t0 = now();
const coldHook = createContextHook({ env: {} });
const factoryMs = now() - t0;
const ev = eventFor(queries[0].query);
coldHook(ev);
const firstCallMs = now() - t0 - factoryMs; // first invocation incl. index build

// 3. explicit index build reference.
const t1 = now();
const { skills } = discoverSkills(defaultRoots());
const index = buildIndex(skills);
const buildMs = now() - t1;

// 4. warm path: a hook over the pre-built index, warmed once, then 60 queries.
const warmHook = createContextHook({
  env: {},
  discover: () => ({ skills }),
  buildIndex: () => index,
});
warmHook(eventFor(queries[0].query)); // warm-up (index already built)

const searchSamples = [];
const fullSamples = [];
let blockCount = 0;
for (const q of queries) {
  const a = now();
  search(index, q.query, { limit: 10 });
  searchSamples.push(now() - a);

  const system = [];
  const e = eventFor(q.query);
  e.system = system;
  const b = now();
  warmHook(e);
  fullSamples.push(now() - b);
  if (system.length > 0) blockCount += 1;
}

const sSearch = stats(searchSamples);
const sFull = stats(fullSamples);

console.log("skill-mcp latency — heldout.jsonl (60 queries), hint path = plugin/hint.mjs");
console.log(`skills indexed: ${skills.length}`);
console.log("");
console.log(`index build (discover + buildIndex)      : ${ms(buildMs)}`);
console.log(`factory (config load, once per process)  : ${ms(factoryMs)}`);
console.log(`FIRST CALL (cold hook, incl. index build): ${ms(firstCallMs)}`);
console.log("");
console.log(`warm search only (core search, limit=10), n=${sSearch.n}`);
console.log(`  p50=${ms(sSearch.p50)}  p95=${ms(sSearch.p95)}  max=${ms(sSearch.max)}  mean=${ms(sSearch.mean)}  min=${ms(sSearch.min)}`);
console.log(`warm full hint path (search + filter + block), n=${sFull.n}`);
console.log(`  p50=${ms(sFull.p50)}  p95=${ms(sFull.p95)}  max=${ms(sFull.max)}  mean=${ms(sFull.mean)}  min=${ms(sFull.min)}`);
console.log("");
console.log(`blocks emitted: ${blockCount}/${queries.length} (≤${150} ms budget is enforced by the hook itself — over-budget hints are dropped)`);

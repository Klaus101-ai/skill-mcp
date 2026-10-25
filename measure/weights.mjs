// measure/weights.mjs — field-weight candidates compared on the FIXED A set
// (measure/heldout.jsonl, commit bbf9c74) through the PRODUCTION search()
// (gate + stemming included), only `boost` differs per candidate.
//
// Selection rule (see measure/README.md § Weights): highest recall@5 over all
// eligible queries; ties broken by all@5, then NDCG@10; easy and hard must not
// regress against the current 3/2/1 configuration. Queries, qrels, stop words
// and thresholds are NOT touched — this script only reads the set.
//
// Usage: node measure/weights.mjs [--verbose]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");
const K = 5;
const N = 10;
const KINDS = ["easy", "hard", "empty"];

const CANDIDATES = [
  { label: "name 3 / desc 2 / head 1 (M4)", boost: { name: 3, description: 2, headings: 1 } },
  { label: "name 2 / desc 3 / head 1", boost: { name: 2, description: 3, headings: 1 } },
  { label: "name 1.5 / desc 3 / head 1", boost: { name: 1.5, description: 3, headings: 1 } },
];

const queries = fs
  .readFileSync(path.join(HERE, "heldout.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const { skills } = discoverSkills(defaultRoots());
const present = new Set(skills.map((s) => s.name));
const index = buildIndex(skills);

function dcg(hits) {
  return hits.reduce((s, rel, i) => (rel ? s + 1 / Math.log2(i + 2) : s), 0);
}
function ndcgAt(ranked, relevant) {
  const idealN = Math.min(relevant.length, N);
  if (idealN === 0) return null;
  const idcg = dcg(new Array(idealN).fill(true));
  const rel = new Set(relevant);
  return dcg(ranked.slice(0, N).map((name) => rel.has(name))) / idcg;
}

function scoreConfig(boost) {
  const byKind = {};
  for (const k of KINDS) byKind[k] = { n: 0, eligible: 0, hit: 0, all: 0, ndcg: 0 };
  let ac3NonEmpty = 0;
  const misses = [];

  for (const q of queries) {
    const top = search(index, q.query, { limit: N, boost }).map((r) => r.name);
    if ((q.qrels || []).length === 0) {
      if (top.length > 0) ac3NonEmpty += 1;
      byKind.empty.n += 1;
      continue;
    }
    const relevant = (q.qrels || []).filter((r) => present.has(r));
    byKind[q.kind].n += 1;
    if (relevant.length === 0) continue;
    byKind[q.kind].eligible += 1;
    const cut = top.slice(0, K);
    const hit = relevant.some((r) => cut.includes(r));
    const all = relevant.every((r) => cut.includes(r));
    const nd = ndcgAt(top, relevant) ?? 0;
    byKind[q.kind].hit += hit ? 1 : 0;
    byKind[q.kind].all += all ? 1 : 0;
    byKind[q.kind].ndcg += nd;
    if (!hit && VERBOSE) misses.push(`  MISS #${q.id} [${q.kind}] ${q.query} -> ${top.slice(0, 5).join(", ")}`);
  }

  const agg = (kindList) => {
    const e = kindList.reduce((s, k) => s + byKind[k].eligible, 0);
    const h = kindList.reduce((s, k) => s + byKind[k].hit, 0);
    const a = kindList.reduce((s, k) => s + byKind[k].all, 0);
    const n = kindList.reduce((s, k) => s + byKind[k].ndcg, 0);
    return {
      eligible: e,
      recall: e ? h / e : null,
      all: e ? a / e : null,
      ndcg: e ? n / e : null,
      hits: h,
    };
  };

  return {
    easy: agg(["easy"]),
    hard: agg(["hard"]),
    all: agg(["easy", "hard"]),
    ac3NonEmpty,
    misses,
  };
}

const results = CANDIDATES.map((c) => ({ ...c, ...scoreConfig(c.boost) }));

const f = (v) => (v === null || v === undefined ? "  n/a " : v.toFixed(4));
console.log(`weights comparison on A (heldout.jsonl), skills=${skills.length}, gate+stemming ON, recall@5 / all@5 / ndcg@10`);
console.log("");
const rows = [
  ["candidate", "easy r@5", "easy a@5", "hard r@5", "hard a@5", "all r@5", "all a@5", "all ndcg@10", "AC3 non-empty"],
  ...results.map((r) => [
    r.label,
    f(r.easy.recall),
    f(r.easy.all),
    f(r.hard.recall),
    f(r.hard.all),
    f(r.all.recall),
    f(r.all.all),
    f(r.all.ndcg),
    `${r.ac3NonEmpty}/10`,
  ]),
];
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  "));

const base = results[0];
const ranked = [...results].sort(
  (a, b) =>
    (b.all.recall ?? -1) - (a.all.recall ?? -1) ||
    (b.all.all ?? -1) - (a.all.all ?? -1) ||
    (b.all.ndcg ?? -1) - (a.all.ndcg ?? -1),
);
console.log("");
console.log(`winner by rule (all recall@5, then all@5, then ndcg@10): ${ranked[0].label}`);
for (const r of results.slice(1)) {
  const regressEasy = r.easy.recall < base.easy.recall;
  const regressHard = r.hard.recall < base.hard.recall;
  console.log(
    `  vs 3/2/1 — ${r.label}: easy ${regressEasy ? "REGRESSED" : "ok"}, hard ${regressHard ? "REGRESSED" : "ok"}`,
  );
}
if (VERBOSE) for (const r of results) if (r.misses.length) console.log(`\nmisses [${r.label}]:\n${r.misses.join("\n")}`);

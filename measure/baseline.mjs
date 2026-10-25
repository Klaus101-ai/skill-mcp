// Baseline: an independent TF-IDF/BM25 implementation (no MiniSearch) over
// the same skill data, used for AC2: product recall@k must be >= baseline.
// Usage: node measure/baseline.mjs --k 5 [--verbose]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const K = (() => {
  const i = process.argv.indexOf("--k");
  if (i >= 0 && process.argv[i + 1]) {
    const v = Number.parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 5;
})();
const VERBOSE = process.argv.includes("--verbose");

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/** Classic BM25 (k=1.2, b=0.7) over document text. */
class Bm25 {
  constructor(docs, k = 1.2, b = 0.7) {
    this.k = k;
    this.b = b;
    this.docs = docs.map((d, id) => {
      const terms = tokenize(d.text);
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      return { id, name: d.name, tf, dl: terms.length };
    });
    this.N = this.docs.length;
    this.avgdl = this.docs.reduce((s, d) => s + d.dl, 0) / (this.N || 1);
    this.df = new Map();
    for (const d of this.docs) {
      for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
  }

  idf(term) {
    const df = this.df.get(term) || 0;
    return Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
  }

  search(query, k = 5) {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const scored = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const denom = f + this.k * (1 - this.b + (this.b * d.dl) / (this.avgdl || 1));
        score += this.idf(t) * ((f * (this.k + 1)) / denom);
      }
      if (score > 0) scored.push({ name: d.name, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return scored.slice(0, k);
  }
}

const { skills } = discoverSkills(defaultRoots());
const bm25 = new Bm25(
  skills.map((s) => ({
    name: s.name,
    text: `${s.name} ${s.name} ${s.description} ${s.bodyHeadings.join(" ")}`,
  })),
);

const queriesPath = path.join(HERE, "queries.jsonl");
const queries = fs
  .readFileSync(queriesPath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const present = new Set(skills.map((s) => s.name));
let hits = 0;
let eligible = 0;

for (const q of queries) {
  const relevant = (q.relevant || []).filter((r) => present.has(r));
  if (relevant.length === 0) {
    if (VERBOSE) console.log(`skip  #${q.id} "${q.query}" — no qrel skill in index`);
    continue;
  }
  eligible += 1;
  const top = bm25.search(q.query, K);
  const hit = top.some((r) => relevant.includes(r.name));
  if (hit) hits += 1;
  if (VERBOSE) {
    console.log(`${hit ? "hit " : "MISS"} #${q.id} "${q.query}" -> ${top.map((t) => t.name).join(", ")}`);
  }
}

const recall = eligible > 0 ? hits / eligible : 0;
console.log(`baseline: BM25(k=1.2,b=0.7), skills=${skills.length}, queries=${queries.length}`);
console.log(`recall@${K} = ${recall.toFixed(4)} (${hits}/${eligible} eligible; ${queries.length - eligible} skipped: qrel not in index)`);

// Held-out measurement (M4): recall@5 / all-qrels@5 / NDCG@10 on
// measure/heldout.jsonl, product (core/index.mjs) vs baseline
// (measure/baseline.mjs BM25), plus the AC3 block for `empty` queries.
//
// The query set is FIXED (commit "M4: held-out query set (independent)"):
// queries, qrels, weights, stop words and thresholds must NOT be changed
// after a run. One run, honest reporting.
//
// Eligibility (same rule as baseline.mjs): a query counts toward the
// retrieval averages only if at least one qrel skill is present in the
// index; qrels missing from the index are listed separately, not silently
// dropped. NDCG gains are binary (qrel present in top-10 = 1).
//
// Usage: node measure/run.mjs [--set <path>] [--json] [--verbose]
// --set defaults to measure/heldout.jsonl; the methodology is identical
// for any set (same metrics, same eligibility rule, same AC3 block).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";
import { Bm25, baselineDocs } from "./baseline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_OUT = process.argv.includes("--json");
const VERBOSE = process.argv.includes("--verbose");
const K = 5; // recall@k, all@k
const N = 10; // NDCG@10
const KINDS = ["easy", "hard", "empty"];

const setArgIdx = process.argv.indexOf("--set");
const setArg = setArgIdx >= 0 ? process.argv[setArgIdx + 1] : null;
const SET_PATH = !setArg
  ? path.join(HERE, "heldout.jsonl")
  : path.isAbsolute(setArg)
    ? setArg
    : fs.existsSync(setArg)
      ? path.resolve(setArg)
      : path.join(HERE, setArg);

const queries = fs
  .readFileSync(SET_PATH, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const { skills } = discoverSkills(defaultRoots());
const present = new Set(skills.map((s) => s.name));
const productIndex = buildIndex(skills);
const bm25 = new Bm25(baselineDocs(skills));

function dcg(hits) {
  // hits: boolean per rank (1-based rank i -> rel / log2(i+1))
  return hits.reduce((s, rel, i) => (rel ? s + 1 / Math.log2(i + 2) : s), 0);
}

function ndcgAt(ranked, relevant) {
  const idealN = Math.min(relevant.length, N);
  if (idealN === 0) return null;
  const idcg = dcg(new Array(idealN).fill(true));
  if (idcg === 0) return null;
  const rel = new Set(relevant);
  const gains = ranked.slice(0, N).map((name) => rel.has(name));
  return dcg(gains) / idcg;
}

const missingQrels = new Map(); // query id -> qrels absent from the index
const perQuery = [];
const ac3 = [];

let pool = { n: 0, eligible: 0, pHits: 0, pAll: 0, bHits: 0, bAll: 0, pNdcg: 0, bNdcg: 0 };
const byKind = {};
for (const k of KINDS) byKind[k] = { n: 0, eligible: 0, pHits: 0, pAll: 0, bHits: 0, bAll: 0, pNdcg: 0, bNdcg: 0 };

function addRow(kind, row) {
  byKind[kind].n += 1;
  if (!row) return;
  byKind[kind].eligible += 1;
  byKind[kind].pHits += row.product.hit ? 1 : 0;
  byKind[kind].pAll += row.product.all ? 1 : 0;
  byKind[kind].bHits += row.baseline.hit ? 1 : 0;
  byKind[kind].bAll += row.baseline.all ? 1 : 0;
  byKind[kind].pNdcg += row.product.ndcg;
  byKind[kind].bNdcg += row.baseline.ndcg;
  pool.n += 1;
  pool.eligible += 1;
  pool.pHits += row.product.hit ? 1 : 0;
  pool.pAll += row.product.all ? 1 : 0;
  pool.bHits += row.baseline.hit ? 1 : 0;
  pool.bAll += row.baseline.all ? 1 : 0;
  pool.pNdcg += row.product.ndcg;
  pool.bNdcg += row.baseline.ndcg;
}

for (const q of queries) {
  if ((q.qrels || []).length === 0) {
    // AC3: `empty`-queries must yield nothing useful.
    const top = search(productIndex, q.query, { limit: K });
    const nonEmpty = top.length > 0;
    const positive = top.some((r) => Number(r.score) > 0);
    ac3.push({
      id: q.id,
      query: q.query,
      returned: nonEmpty,
      positiveScore: positive,
      top: top.map((r) => ({ name: r.name, score: r.score })),
    });
    byKind.empty.n += 1;
    perQuery.push({ id: q.id, kind: q.kind, query: q.query, ac3: { returned: nonEmpty, positive } });
    continue;
  }

  const relevant = (q.qrels || []).filter((r) => present.has(r));
  const absent = (q.qrels || []).filter((r) => !present.has(r));
  if (absent.length > 0) missingQrels.set(q.id, absent);

  const productTop = search(productIndex, q.query, { limit: N }).map((r) => r.name);
  const baselineTop = bm25.search(q.query, N).map((r) => r.name);

  if (relevant.length === 0) {
    // Every qrel is absent from the index — not scorable, report it.
    byKind[q.kind].n += 1;
    perQuery.push({ id: q.id, kind: q.kind, query: q.query, eligible: false, absent });
    continue;
  }

  const relSet = new Set(relevant);
  const scoreTop = (top) => {
    const cut = top.slice(0, K);
    const hit = cut.some((name) => relSet.has(name));
    const all = relevant.every((name) => relSet.has(name) && cut.includes(name));
    const ndcg = ndcgAt(top, relevant);
    return { hit, all, ndcg: ndcg === null ? 0 : ndcg, top10: top.slice(0, N) };
  };

  const row = {
    id: q.id,
    kind: q.kind,
    query: q.query,
    qrels: q.qrels,
    relevantPresent: relevant,
    absent,
    eligible: true,
    product: scoreTop(productTop),
    baseline: scoreTop(baselineTop),
  };
  addRow(q.kind, row);
  perQuery.push(row);
  if (VERBOSE) {
    const mark = row.product.hit ? "hit " : "MISS";
    console.log(`${mark} #${q.id} p=[${row.product.top10.join(", ")}]`);
  }
}

// --- aggregation -------------------------------------------------------
const agg = (r) =>
  r.eligible > 0
    ? {
        eligible: r.eligible,
        product: {
          recall_at_5: r.pHits / r.eligible,
          all_at_5: r.pAll / r.eligible,
          ndcg_at_10: r.pNdcg / r.eligible,
          hits: r.pHits,
          allHits: r.pAll,
        },
        baseline: {
          recall_at_5: r.bHits / r.eligible,
          all_at_5: r.bAll / r.eligible,
          ndcg_at_10: r.bNdcg / r.eligible,
          hits: r.bHits,
          allHits: r.bAll,
        },
      }
    : { eligible: 0, product: null, baseline: null };

const kindsOut = {};
for (const k of KINDS) kindsOut[k] = { n: byKind[k].n, ...agg(byKind[k]) };

const ac3Returned = ac3.filter((a) => a.returned);
const ac3Positive = ac3.filter((a) => a.positiveScore);

const setLabel = SET_PATH.startsWith(HERE + path.sep)
  ? path.relative(HERE, SET_PATH).split(path.sep).join("/")
  : SET_PATH;

const result = {
  set: setLabel,
  skills: skills.length,
  queries: queries.length,
  k: K,
  ndcg_n: N,
  kinds: kindsOut,
  all: agg(pool),
  ac3: {
    emptyQueries: ac3.length,
    returnedNonEmpty: ac3Returned.length,
    returnedNonEmptyIds: ac3Returned.map((a) => a.id),
    positiveScore: ac3Positive.length,
    positiveScoreIds: ac3Positive.map((a) => a.id),
    detail: ac3,
  },
  missingQrels: Object.fromEntries(missingQrels),
  perQuery,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const pct = (v) => (v === null || v === undefined ? "  n/a " : v.toFixed(4));
  console.log(`held-out measurement — ${result.set} | skills=${result.skills} | queries=${result.queries} | recall@${K}, NDCG@${N}`);
  console.log("");
  const head = ["kind", "n", "elig", "P recall@5", "P all@5", "P ndcg@10", "B recall@5", "B all@5", "B ndcg@10"];
  const row = (label, r) => [
    label,
    String(r.n ?? ""),
    r.eligible !== undefined && r.eligible !== null ? String(r.eligible) : "",
    pct(r.product?.recall_at_5),
    pct(r.product?.all_at_5),
    pct(r.product?.ndcg_at_10),
    pct(r.baseline?.recall_at_5),
    pct(r.baseline?.all_at_5),
    pct(r.baseline?.ndcg_at_10),
  ];
  const qrelsQueries = queries.filter((q) => (q.qrels || []).length > 0).length;
  const lines = [
    head,
    ...KINDS.map((k) => row(k, kindsOut[k])),
    row("ALL(qrels)", { n: qrelsQueries, ...result.all }),
  ];
  const widths = head.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  for (const l of lines) console.log(l.map((c, i) => c.padEnd(widths[i])).join("  "));
  console.log("");
  console.log("P = product (core MiniSearch, name x3 / description x2 / headings x1)");
  console.log("B = baseline (independent BM25 k=1.2 b=0.7, no MiniSearch)");
  console.log(`eligible = at least one qrel present in the index; product recall@5 >= baseline: ${result.all.product.recall_at_5 >= result.all.baseline.recall_at_5 ? "YES" : "NO"}`);
  console.log("");
  console.log(`AC3 — empty queries: ${result.ac3.emptyQueries} total, non-empty result: ${result.ac3.returnedNonEmpty} (ids: ${result.ac3.returnedNonEmptyIds.join(", ") || "-"}), score>0: ${result.ac3.positiveScore} (ids: ${result.ac3.positiveScoreIds.join(", ") || "-"})`);
  for (const d of result.ac3.detail) {
    console.log(`  #${d.id} returned=${d.returned} score>0=${d.positiveScore} top=[${d.top.map((t) => `${t.name}:${t.score.toFixed(3)}`).join(", ")}] — ${d.query}`);
  }
  const mq = Object.entries(result.missingQrels);
  console.log("");
  console.log(mq.length === 0 ? "missing qrels: none" : `missing qrels (not in index): ${mq.map(([id, list]) => `#${id}[${list.join("|")}]`).join(", ")}`);
}

// Hint measurement (v0.3 split, v0.4 candidates, v0.4.1 variant G).
//
// Owner decision 26.10.2026 split search from the hint, and the v0.4 owner
// decision («5 кандидатов») turned the hint into a CANDIDATE list: up to 5
// entries (confident first, «(возможно)» on unconfirmed ones) — the agent's
// model chooses. `measure/run.mjs` still measures the search (recall@5 /
// NDCG@10 / its raw AC3 block); this script measures what the model actually
// sees:
//
//   - easy / hard (qrel queries): in what share of cases a `<skill_hint>`
//     block forms at all (formed), and in what share of cases its entries
//     contain an ethalon qrel skill —
//       hit@2 = qrel inside the block's first two entries (the pre-v0.4
//               metric, kept for continuity),
//       hit@5 = qrel anywhere inside the block (the block now holds ≤5
//               entries, so this is the hint's own recall@5);
//   - `empty` (10 junk queries per set): how many times a block forms —
//     AC3 is rephrased in v0.4 as «кандидаты, не утверждение» (candidates,
//     not an assertion), so the junk-rate counts marked candidates shown on
//     everyday questions, not claims of an answer.
//   - v0.4.1 (variant G) also reports **find@10**: the MCP `find` pool —
//     a qrel inside the top-10 of `search(query, {limit:10})` (the core now
//     expands the query («описание»→+«текст», «продукт»→+«product») and
//     applies the BOOST_ORDER domain boost, so this is G's find@10, the
//     number the variants lab reported as 43/44/42 on A/B/C).
//
// Hit is scored over the ELIGIBLE queries (≥1 qrel present in the index),
// the same eligibility rule as measure/run.mjs; `formed` is scored over all
// queries of the kind. The block is read from the real hook output (same path
// as opencode), one hook instance per run (index built once, then warmed —
// the steady-state behaviour; the first cold call is excluded on purpose,
// measure/latency.mjs reports that number).
//
// The query sets are FIXED (see measure/README.md) and are never modified.
//
// Usage: node measure/hint.mjs [--set <path>] [--json]
//   no --set  -> all three sets: heldout.jsonl, heldout-b.jsonl, heldout-c.jsonl
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";
import { createContextHook } from "../plugin/hint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_OUT = process.argv.includes("--json");
const KINDS = ["easy", "hard", "empty"];
const DEFAULT_SETS = ["heldout.jsonl", "heldout-b.jsonl", "heldout-c.jsonl"];

const setArgIdx = process.argv.indexOf("--set");
const setArg = setArgIdx >= 0 ? process.argv[setArgIdx + 1] : null;
const SET_PATHS = !setArg
  ? DEFAULT_SETS.map((f) => path.join(HERE, f))
  : path.isAbsolute(setArg)
    ? [setArg]
    : fs.existsSync(setArg)
      ? [path.resolve(setArg)]
      : [path.join(HERE, setArg)];

function loadQueries(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Entry names of a formed block: lines «- <name>[ (возможно)]: …» (the plugin's v0.4 format). */
function entryNames(block) {
  return block
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).replace(" (возможно)", "").split(":")[0]);
}

function eventFor(text) {
  return { system: [], messages: [{ role: "user", content: [{ type: "text", text }] }], agent: "" };
}

const { skills } = discoverSkills(defaultRoots());
const present = new Set(skills.map((s) => s.name));

// One hook for the whole run = one index build (the plugin's once-per-process
// cache), warmed once below so the 150 ms budget never drops a measured hint.
const hook = createContextHook({ env: {}, debug: false });
hook(eventFor("warm-up: index build, not measured"));

// v0.4.1 (G): a separate plain index for the find@10 metric — the MCP `find`
// path (core search limit 10, expansion + domain boost included) without the
// hook's deny/allow and block budgets. Built once per run.
const findIndex = buildIndex(skills);

function measureSet(file) {
  const queries = loadQueries(file);
  const byKind = {};
  for (const k of KINDS) byKind[k] = { n: 0, eligible: 0, formed: 0, hit: 0, hit2: 0, junk: 0, find10: 0 };

  const perQuery = [];
  for (const q of queries) {
    const kind = KINDS.includes(q.kind) ? q.kind : "empty";
    const row = { id: q.id, kind, query: q.query };

    const ev = eventFor(q.query);
    hook(ev);
    const formed = ev.system.length > 0; // the hook appends exactly one part
    const names = formed ? entryNames(ev.system[0].text) : [];
    row.formed = formed;
    row.entries = names;

    byKind[kind].n += 1;
    if (formed) byKind[kind].formed += 1;
    if (kind === "empty") {
      if (formed) byKind[kind].junk += 1;
      perQuery.push(row);
      continue;
    }

    const qrels = q.qrels || [];
    const relevant = qrels.filter((r) => present.has(r));
    const eligible = relevant.length > 0;
    row.eligible = eligible;
    row.qrels = qrels;
    if (eligible) {
      byKind[kind].eligible += 1;
      const relSet = new Set(relevant);
      row.hit = names.some((n) => relSet.has(n)); // hit@5: anywhere in the ≤5-entry block
      row.hit2 = names.slice(0, 2).some((n) => relSet.has(n)); // hit@2: first two entries (pre-v0.4 metric)
      if (row.hit) byKind[kind].hit += 1;
      if (row.hit2) byKind[kind].hit2 += 1;
      // v0.4.1 (G): find@10 — a qrel inside the `find` pool (core search,
      // limit 10, expansion + BOOST_ORDER boost applied inside `search`).
      const top10 = search(findIndex, q.query, { limit: 10 }).map((h) => h.name);
      row.find10 = top10.some((n) => relSet.has(n));
      if (row.find10) byKind[kind].find10 += 1;
    } else {
      row.hit = false;
      row.hit2 = false;
      row.find10 = false;
    }
    perQuery.push(row);
  }

  const label = path.relative(HERE, file).split(path.sep).join("/") || file;
  return { set: label, skills: skills.length, queries: queries.length, kinds: byKind, perQuery };
}

const results = SET_PATHS.map(measureSet);

if (JSON_OUT) {
  console.log(JSON.stringify({ skills: skills.length, sets: results }, null, 2));
  process.exit(0);
}

const frac = (v) => (v === null || v === undefined ? "  n/a " : v.toFixed(4));
const pct = (v) => (v === null || v === undefined ? "  n/a " : `${(v * 100).toFixed(1)}%`);

for (const r of results) {
  console.log(`hint measurement — ${r.set} | skills=${r.skills} | queries=${r.queries} | block ≤5 candidates, confident first, «(возможно)» on unconfirmed | v0.4.1 G: expansion + domain boost in core search, tool-silence + confident gate in the hint`);
  const head = ["kind", "n", "formed", "formed%", "elig", "hit@2", "hit@2%", "hit@5", "hit@5%", "find@10", "junk"];
  const rows = KINDS.map((k) => {
    const b = r.kinds[k];
    if (k === "empty") {
      return [k, String(b.n), String(b.formed), pct(b.n ? b.formed / b.n : null), "-", "-", "-", "-", "-", "-", `${b.junk}/${b.n}`];
    }
    return [
      k,
      String(b.n),
      String(b.formed),
      pct(b.n ? b.formed / b.n : null),
      String(b.eligible),
      String(b.hit2),
      b.eligible > 0 ? frac(b.hit2 / b.eligible) : "  n/a ",
      String(b.hit),
      b.eligible > 0 ? frac(b.hit / b.eligible) : "  n/a ",
      `${b.find10}/${b.eligible}`,
      "-",
    ];
  });
  const lines = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  for (const l of lines) console.log(l.map((c, i) => c.padEnd(widths[i])).join("  "));
  const e = r.kinds.empty;
  const elig = r.kinds.easy.eligible + r.kinds.hard.eligible;
  const f10 = r.kinds.easy.find10 + r.kinds.hard.find10;
  console.log(`empty: hint formed ${e.junk}/${e.n} — candidates shown on everyday questions (AC3 v0.4: «кандидаты, не утверждение»; v0.4.1 confident gate + tool-silence cut this)`);
  console.log(`find@10 (core search limit 10, G expansion + boost): ${f10}/${elig} = ${elig ? pct(f10 / elig) : "n/a"}`);
  console.log("");
}

console.log("formed = a <skill_hint> block was appended to `system` for that query");
console.log("hit@2  = an ethalon qrel sits inside the block's FIRST TWO entries (eligible queries only; pre-v0.4 metric)");
console.log("hit@5  = an ethalon qrel sits ANYWHERE inside the block (≤5 entries; the hint's recall@5)");
console.log("find@10 = an ethalon qrel sits inside the top-10 of `find` (core search, expansion + domain boost, v0.4.1 G)");
console.log("junk   = a block formed on an `empty` query — every entry there is marked candidate material, not an answer claim");

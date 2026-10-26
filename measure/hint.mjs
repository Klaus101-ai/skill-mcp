// Hint measurement (v0.3): the HINT, not the search.
//
// Owner decision 26.10.2026 split search from the hint: `search()` returns
// the full list with a `confident` flag, and plugin/hint.mjs builds its block
// from `confident:true` positions only. `measure/run.mjs` still measures the
// search (recall@5 / NDCG@10 / its raw AC3 block); this script measures what
// the model actually sees:
//
//   - easy / hard (qrel queries): in what share of cases a `<skill_hint>`
//     block forms at all (formed), and in what share of cases its top-2
//     entries contain an ethalon qrel skill (hit, the hint analogue of
//     recall@5 — the block holds ≤2 positions);
//   - `empty` (10 junk queries per set): how many times a block forms —
//     the AC3 criterion «no random hints», target 0/10.
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

/** Entry names of a formed block: lines «- <name>: …» (the plugin's format). */
function entryNames(block) {
  return block
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).split(":")[0]);
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

function measureSet(file) {
  const queries = loadQueries(file);
  const byKind = {};
  for (const k of KINDS) byKind[k] = { n: 0, eligible: 0, formed: 0, hit: 0, junk: 0 };

  const perQuery = [];
  for (const q of queries) {
    const kind = KINDS.includes(q.kind) ? q.kind : "empty";
    const row = { id: q.id, kind, query: q.query };

    const ev = eventFor(q.query);
    hook(ev);
    const formed = ev.system.length > 0; // the hook appends exactly one part
    const names = formed ? entryNames(ev.system[0].text) : [];
    row.formed = formed;
    row.top2 = names;

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
      row.hit = names.some((n) => relSet.has(n));
      if (row.hit) byKind[kind].hit += 1;
    } else {
      row.hit = false;
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
  console.log(`hint measurement — ${r.set} | skills=${r.skills} | queries=${r.queries} | block ≤2 entries, built from confident:true only`);
  const head = ["kind", "n", "formed", "formed%", "elig", "hit", "hit%", "junk"];
  const rows = KINDS.map((k) => {
    const b = r.kinds[k];
    if (k === "empty") {
      return [k, String(b.n), String(b.formed), pct(b.n ? b.formed / b.n : null), "-", "-", "-", `${b.junk}/${b.n}`];
    }
    return [
      k,
      String(b.n),
      String(b.formed),
      pct(b.n ? b.formed / b.n : null),
      String(b.eligible),
      String(b.hit),
      b.eligible > 0 ? frac(b.hit / b.eligible) : "  n/a ",
      "-",
    ];
  });
  const lines = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  for (const l of lines) console.log(l.map((c, i) => c.padEnd(widths[i])).join("  "));
  const e = r.kinds.empty;
  console.log(`empty: hint formed ${e.junk}/${e.n} (target 0/10)${e.junk === 0 ? " — OK" : ""}`);
  console.log("");
}

console.log("formed = a <skill_hint> block was appended to `system` for that query");
console.log("hit    = an ethalon qrel is inside the block's top-2 entries (eligible queries only)");
console.log("junk   = a block formed on an `empty` query — must stay 0/10 (AC3 belongs to the hint, v0.3)");

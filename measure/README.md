# measure/ — evaluation harness

## Query sets

Two sets exist and they play different roles:

- `queries.jsonl` — **draft** set (28 queries, field `relevant`). It was written
  while building the harness, to smoke-check the scripts. It is **not** for
  tuning weights, stop words or thresholds and is **not** the reported set.
- `heldout.jsonl` — **held-out** set (60 queries, field `qrels`, `kind` ∈
  `easy` | `hard` | `empty`). It was composed **independently** by a different
  agent and is **not** to be adjusted to the system. It was committed as
  `M4: held-out query set (independent)` **before** any measurement run, so the
  history proves the set predates the numbers. Once committed, queries, qrels,
  weights, stop words and thresholds must not be changed to improve results.

`heldout.jsonl` line shape:

```json
{"id": 1, "query": "...", "qrels": ["skill-name", ...], "kind": "easy"}
```

- `easy` (35) — one clearly named skill; `hard` (15) — two qrels, an ambiguous
  or multi-skill request; `empty` (10) — everyday questions with **no** skill
  answer (`qrels: []`), used for the AC3 block.
- `qrels` hold **skill names** (frontmatter `name`), not folder names.

## Metrics (`run.mjs`)

Eligibility follows `baseline.mjs`: a query counts toward the retrieval
averages only if at least one qrel is present in the index; qrels absent from
the index are reported separately (`missingQrels`), never silently dropped.

- **recall@5** — share of eligible queries where at least one qrel is in the
  top-5.
- **all@5** — share of eligible queries where **all** (present) qrels are in
  the top-5.
- **NDCG@10** — binary relevance (qrel in the ranked top-10 = 1), ideal DCG
  over `min(|qrels present|, 10)` relevant items; averaged over eligible
  queries.
- **AC3** — for the 10 `empty` queries: how many returned a non-empty result,
  how many with `score > 0`, with the query ids.

Both the **product** (MiniSearch, `core/index.mjs`: name ×3, description ×2,
headings ×1) and the **baseline** (independent BM25 k=1.2 b=0.7,
`measure/baseline.mjs`, no MiniSearch, same skill data) are scored on the same
set in the same run.

## Latency (`latency.mjs`)

Same path as the plugin (`plugin/hint.mjs` `createContextHook`): one factory
call (config), one **cold** first invocation (includes index build), then the
index is warmed once and the 60 held-out queries are timed twice — search only
(`core search`, limit = 10) and the full hint path (search + deny/allow +
«зачем» + block). p50/p95/max are nearest-rank percentiles. `env` is passed as
`{}` so the hint is ON regardless of the shell.

## Reproduce

```sh
npm install
npm test                  # must stay green
node measure/run.mjs      # human table (product vs baseline, by kind + AC3)
node measure/run.mjs --json  # same numbers, machine-readable, incl. per-query tops
node measure/latency.mjs  # p50/p95/max + first-call (index build)
node measure/baseline.mjs --k 5 --verbose   # standalone baseline on the draft set
```

Numbers in the M4 report come from these commands, run **once**. If a metric
is below the baseline, it is reported as is — the set is never adjusted.

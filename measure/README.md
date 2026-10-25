# measure/ — evaluation harness

## Query sets

Two sets exist and they play different roles:

- `queries.jsonl` — **draft** set (28 queries, field `relevant`). It was written
  while building the harness, to smoke-check the scripts. It is **not** for
  tuning weights, stop words or thresholds and is **not** the reported set.
- `heldout.jsonl` — **set A** (60 queries, field `qrels`, `kind` ∈
  `easy` | `hard` | `empty`). It was composed **independently** by a different
  agent and is **not** to be adjusted to the system. It was committed as
  `M4: held-out query set (independent)` **before** any measurement run, so the
  history proves the set predates the numbers.

### Status change (M5): set A is now the VALIDATION set

All M4 measurements on set A are fixed (commit `bbf9c74` / `2a7766f`), so set A
can no longer serve as an honest "untouched" test: M5 changes are **verified**
against it (that is what a validation set is for). From M5 on:

- **set A = validation**: normal iteration happens here — a change is judged by
  its before/after table on A. Queries, qrels and stop words still never change;
  weights and the threshold may only be selected through a *measured comparison
  on A* with the numbers recorded below (M5 § Weights, M5 § Threshold).
- **set B = acceptance (deferred, honest)**: an independent agent will build a
  fresh held-out set B later, with no knowledge of these numbers, and acceptance
  runs there. The formulations in `heldout.jsonl` are **not** modified — the file
  stays byte-identical to commit `bbf9c74`, so M4 and M5 numbers stay comparable.

`heldout.jsonl` line shape:

```json
{"id": 1, "query": "...", "qrels": ["skill-name", ...], "kind": "easy"}
```

- `easy` (35) — one clearly named skill; `hard` (15) — two qrels, an ambiguous
  or multi-skill request; `empty` (10) — everyday questions with **no** skill
  answer (`qrels: []`), used for the AC3 block.
- `qrels` hold **skill names** (frontmatter `name`), not folder names.

## Pipeline under test (M5)

`core/index.mjs` search now runs three steps before anything is returned:

1. **Normalization + light stemming** (`core/text.mjs`): lower-case, `ё`→`е`,
   punctuation stripped, then frequent RU endings (-ами/-ями/-ов/-ев/-ий/-ый/
   -ая/-ое/-ые/-ой/-ей/-ам/-ям/-ах/-ях/-и/-ы/-а/-я/-о/-е/-у/-ю) and EN endings
   (-ing/-es/-ed/-s) are cut with a root-protection floor of 3 characters.
   The same pipeline is injected into MiniSearch as `tokenize` + `processTerm`,
   which MiniSearch applies to documents **and** to query strings — one code
   path, no drift between index and query.
2. **AC3 significant-match gate**: a result is valid only if at least one
   meaningful query token (≥3 chars, not in the frozen ru+en stop list, not
   punctuation — judged after normalization/stemming) really occurs in that
   skill's name+description+headings. If no skill passes, `search()` returns
   `[]` — the MCP `find` turns that into
   `{"ok":true,"items":[],"note":"ничего не найдено"}` and the plugin hint
   simply emits no block (both call the same `search()`).
3. **Relative noise floor** (see M5 § Threshold below).

Stop words and short tokens are still indexed and still contribute to BM25
scores (scoring semantics were not part of M5); they only lose the right to
*prove* a match.

## Metrics (`run.mjs`)

Eligibility follows `baseline.mjs`: a query counts toward the retrieval
averages only if at least one qrel is present in the index; qrels absent from
the index are reported separately (`missingQrels`), never silently dropped.

- **recall@5** — share of eligible queries where at least one qrel is in the
  top-5.
- **all@5** — share of eligible queries where **all** (present) qrels are in the
  top-5.
- **NDCG@10** — binary relevance (qrel in the ranked top-10 = 1), ideal DCG over
  `min(|qrels present|, 10)` relevant items; averaged over eligible queries.
- **AC3** — for the 10 `empty` queries: how many returned a non-empty result,
  how many with `score > 0`, with the query ids.

Both the **product** (MiniSearch, `core/index.mjs`: pipeline above, field weights
below) and the **baseline** (independent BM25 k=1.2 b=0.7, `measure/baseline.mjs`,
no MiniSearch, no stemming, no gate — the unchanged reference) are scored on the
same set in the same run.

## M5 § Weights

Field weights were re-compared on set A with the final pipeline (gate +
stemming) via `measure/weights.mjs` — `search()` takes an optional `boost`
override, so candidates differ **only** in field weights:

| candidate | easy r@5 | easy a@5 | hard r@5 | hard a@5 | all r@5 | all a@5 | all ndcg@10 | AC3 non-empty |
|---|---|---|---|---|---|---|---|---|
| name 3 / desc 2 / head 1 (M4) | 0.7714 | 0.7714 | 0.6000 | 0.2667 | 0.7200 | 0.6200 | 0.6161 | 2/10 |
| name 2 / desc 3 / head 1 | 0.7429 | 0.7429 | 0.6000 | 0.2667 | 0.7000 | 0.6000 | 0.5974 | 3/10 |
| name 1.5 / desc 3 / head 1 | 0.7429 | 0.7429 | 0.6000 | 0.2667 | 0.7000 | 0.6000 | 0.5871 | 3/10 |

Selection rule: highest recall@5 over all eligible queries, ties broken by
all@5 then NDCG@10, easy/hard must not regress against the incumbent. **Winner:
name ×3 / description ×2 / headings ×1** — it wins recall@5 *and* all@5, so the
M4 weights are kept (re-confirmed against two candidates, not assumed).

## M5 § Threshold (relative noise floor)

After the gate, leftovers still existed on A (9/10 non-empty), e.g. a doc whose
only overlap with «Как сварить борщ с говядиной» is the word «как». The floor:

```
ceiling(q) = Σ over meaningful tokens t of q of:
               best score of a one-term search for t in the corpus
               OR  (if t occurs in NO skill)  idf(df=0) · (d + k + 1) · max(field boost)
keep the result list only if  best_score(q) ≥ 0.7 · ceiling(q), else return []
```

Why this ceiling and not a constant score: BM25 scores are not comparable across
queries (idfs and token counts differ by an order of magnitude), so the cutoff is
made *relative to what this query could achieve in this corpus*. The theoretical
part (`idf(df=0)·(d+k+1)·maxBoost`, the exact BM25 saturation upper bound at
k=1.2, b=0.7, d=0.5) stops a query whose rare tokens are simply absent from the
corpus from getting a tiny denominator for free.

Why 0.7 and not a magic number — it is the measured separating gap of set A:

- biggest `empty`-query ratio that must be cut: **0.664** (#57);
- weakest ratio among all 50 qrel queries: **0.720** (#7);
- 0.7 is the largest round value inside the gap [0.664; 0.720].

Effect on A: AC3 non-empty 9 → 2, and easy/hard recall@5, all@5 and NDCG@10 are
**byte-identical** to the pre-floor run (the floor only removed the 10 `empty`
answers and 4 already-zero queries — none of them had a qrel in the top-10).
Known risk for set B: a B query whose best score falls below 0.7 of its ceiling
would be answered with `[]` (on A the closest call is 0.720); this is recorded
in the M5 report as "not verified" until set B exists.

Residual AC3 = 2 (#58, #59): their meaningful EN tokens («when/next/bus/airport»,
«what/should/office») genuinely occur in skill texts — cutting them would mean
cutting real hits (their ratios, 1.43 and 2.51, sit above every qrel query's
minimum). They need semantics, not lexics; they are reported as-is, not hidden.

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
npm test                  # must stay green (incl. text/ac3 M5 tests)
node measure/run.mjs      # human table (product vs baseline, by kind + AC3)
node measure/run.mjs --json  # same numbers, machine-readable, incl. per-query tops
node measure/weights.mjs  # field-weight candidates on set A (M5)
node measure/latency.mjs  # p50/p95/max + first-call (index build)
node measure/baseline.mjs --k 5 --verbose   # standalone baseline on the draft set
```

Numbers in the M4 report come from these commands, run **once**; numbers in the
M5 report are the same commands re-run after the M5 changes, with the before/after
table kept in `writer-report.md`. If a metric is below the baseline, it is
reported as is — the set is never adjusted.

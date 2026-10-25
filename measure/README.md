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
3. **Relative noise floor** (see M5 § Threshold below; re-derived in M6).

M6 amended steps 1–2: words are token-level (`next.js` stays one word, a
hyphen splits), `why` attributes a field by token equality, and upper-case
short acronyms became meaningful — see § M6.

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

Residual AC3 = 2 (#58, #59). **M6 correction (see § M6 § Diagnosis):** the M5
wording below over-claimed — «bus», «airport» and «coffee» do NOT occur in any
skill text at all, and «next» was taken out of the written word «Next.js» by
the punctuation-splitting tokenizer; only the standalone function-like words
«when/next» (#58) and «what/should» (#59) are real token-equal occurrences.
Their ratios (1.43 and 2.51) sit above every qrel query's minimum, so cutting
them would mean cutting real hits — they need semantics, not lexics; reported
as-is, not hidden. M5 text kept verbatim as the historical record:

> their meaningful EN tokens («when/next/bus/airport»,
> «what/should/office») genuinely occur in skill texts — cutting them would mean
> cutting real hits (their ratios, 1.43 and 2.51, sit above every qrel query's
> minimum). They need semantics, not lexics; they are reported as-is, not hidden.

## M6 § Token-level match, words, acronyms

### Diagnosis (checked on the live index, not assumed)

Two claims were verified against the real corpus (365 skills) **before** any
code change:

1. **«the gate compares substrings» — REFUTED for the gate itself.** The
   `search()` gate compares normalized/stemmed tokens by *equality*
   (MiniSearch `r.match` keys are document terms from the same pipeline), so
   «bus» against the word «business» already answered `[]`
   (stems: `bus` → `bus`, `business` → `busin`, `abuse` → `abuse`).
2. **The substring really existed — in two other places:**
   - `why` field attribution used `text.includes(term)`: a skill named
     `Officer-training` with «office» only in its description was reported as
     `matched name+description: office` (false credit to `name`);
   - the tokenizer split on every non-alphanumeric character, so the written
     word **«Next.js»** handed out a free `next` token — in #58's returned
     skills «next» came ONLY from «Next.js» (build-recipes, gsap-react,
     edge-case-auditor).

Where each AC3 token actually occurs (indexed fields, *written* words with
their dots/hyphens):

| token | written words containing it | verdict |
|---|---|---|
| `bus` | `Business`, `business`, `abuse`, `business-website-skill` | never a word of its own; **never matched** (proof above) |
| `airport` | — | absent from the corpus |
| `coffee` | — | absent from the corpus |
| `next` | `next`, `Next`, `next-steps`, `Next.js`, `Next.js-проекта`, `NextSlide`, `nextslide`, `React-Vue-Next` | mixed: standalone «next» exists; in #58's returned skills it came only from «Next.js» |
| `when` | `when`, `When`, `WHEN`, `whenever` | standalone — the real cause of #58 |
| `what` | `what`, `What`, `WHAT`, `whatever` | standalone — the real cause of #59 |
| `should` | `should`, `Should`, `SHOULD` | standalone — the real cause of #59 |
| `office` | `office`, `Office`, `Officer`, `officer` | standalone exists (`pep-screening`, `rospatent-application`) *and* inside «Officer» |

So #58/#59 are **not** substring artifacts: they survive on genuine
token-equal occurrences of function-like English words (`when`, `next`,
`what`, `should`). The leftovers are semantic noise, not lexical noise.

### Word rule (the implementation)

A **word** is a run of letters/digits that may contain a **dot**, never a
**hyphen** (`core/text.mjs` `tokenize`); the gate and `why` count a match only
when a normalized/stemmed query token is **equal** to a word of the skill text.

- **dot stays inside the word**: `next.js` is one word → `next` ∌ `next.js`
  (required test), while the query «next.js» still matches the same text —
  the rule is identical on both sides. The whole-word query folds as
  `next.js` → `nextjs` → stem `nextj`.
- **hyphen splits the word**: `gsap` **does** match `gsap-scrolltrigger`
  (required decision — a hyphen joins independent words: `gsap-scrolltrigger`,
  `next-steps`, and it is the boundary in mixed-script compounds like
  `AI-документ`, which would otherwise become one unusable token). Tested in
  `test/ac3.test.mjs`.

### M6 § Acronyms (short-token whitelist)

`MIN_TOKEN_LENGTH = 3` used to make every 2-char token unprovable, and #47
(«Подготовь внутренний AI-документ…», qrels `aia-generation` +
`use-case-triage-ai-governance`) overlaps with its qrels only through «AI» —
both qrel skills were **filtered out by the gate** (their only shared terms
were `ai` and the stop word `и`). Whitelist (Latin, written **upper case in
the source**): `ai, ml, ui, ux, qa, pr, hr, it, ci, cd, db, api, sdk, gpu`.

Why exactly these: they are the standard IT/UI/ML/quality/delivery acronyms
that carry meaning on their own in skill texts and queries; `api/sdk/gpu` are
3 chars anyway and are listed for completeness. Why **upper case only**:
capitalization is the one signal separating an acronym from an ordinary word —
lowercase `it` is the English pronoun (would prove a match in almost any
English description), and the frozen M5 test (`significantQueryTokens("ai go x")
== []`) fixes lower/mixed case as insignificant. RU stop words `и`, `в`, `с`,
`на` are unchanged and still prove nothing.

Effect on set A: exactly 4 queries gain a token — #23 `AI`, #44 `UI`, #45 `UX`,
#47 `AI`. #23/#44/#45 keep ratios 6.33 / 2.92 / 3.51 (far above the floor);
#47 see § M6 § Threshold.

### M6 § Threshold (MIN_STRENGTH re-derived)

The floor is still **needed**: without it 9 of the 10 `empty` queries return a
non-empty list (only #52 fails the gate), i.e. AC3 would be 9/10, not 10/10 —
token-level matching does not remove #58/#59 because their tokens are genuine
standalone words. Re-derived on A **after** M6, same method as M5 (pre-floor
best score of the gated list ÷ `corpusCeiling`, `measure`-independent script):

| side | value | id |
|---|---|---|
| biggest `empty` ratio that must be cut | **0.6658** | #57 (M5: 0.6644) |
| weakest qrel answer that is kept | **0.7171** | #32 (M5 recorded 0.720 for #7; recomputation on M5 code gives #32 = 0.7176 — same gap, M5's id/rounding was slightly off) |
| selected | **0.7** = largest round value inside (0.6658; 0.7171] | — |

Cut but metric-neutral (no qrel in their gated top-10): #4 (0.6123), #14
(0.1187), #40 (0.4589). **Reported limitation, not tuned away:** #47 now has
`use-case-triage-ai-governance` at gated rank 6 (the acronym fix works at the
gate level), but its ratio is 0.4967 — three of its query tokens are absent
from the corpus and add the theoretical bound to the ceiling — so the floor
still answers #47 with `[]`, exactly as in M5. Lowering the floor to 0.5 would
re-admit empty #57 (0.6658) and #55 (0.5015) → AC3 would fall to 4/10; that
trade-off needs an owner decision and was **not** made unilaterally (no tuning
to a single id).

### M5 → M6 (set A, same commands)

| metric | M5 | M6 |
|---|---|---|
| easy recall@5 / all@5 | 0.7714 / 0.7714 | 0.7714 / 0.7714 |
| hard recall@5 / all@5 | 0.6000 / 0.2667 | 0.6000 / 0.2667 |
| ALL recall@5 / all@5 | 0.7200 / 0.6200 | 0.7200 / 0.6200 |
| ALL NDCG@10 | 0.6161 | 0.6161 |
| AC3 non-empty | 2/10 (#58, #59) | 2/10 (#58, #59; #58's top list no longer contains `Next.js`-derived hits) |
| draft set (28) product recall@5 | 0.9643 (27/28, MISS #13) | 0.9643 (27/28, MISS #13) |
| warm search p95 | 1.68 ms | 2.38 ms (token-level `why` attribution; 2.3–3.0 ms across runs, ≤150 ms budget unaffected) |
| weights winner | name ×3 / desc ×2 / head ×1 | unchanged (re-run, same winner) |

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

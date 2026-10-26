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
  its before/after table on A. Queries and qrels never change; weights are only
  selected through a *measured comparison on A* with the numbers recorded below
  (M5 § Weights). Two one-time, task-driven exceptions, both recorded in the
  reports: the stop list was extended to the standard service-word list in M7
  (the set files themselves stayed byte-identical), and the score threshold was
  **abolished** in M7 in favour of the coverage rule (M7 § Rule) — so there is
  no threshold left to select.
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
2. **AC3 significant-match gate**: a result is valid only if it covers enough
   meaningful query tokens — **`≥ min(2, N)`** since M7, where N is the number
   of meaningful tokens (≥3 chars or an upper-case whitelisted acronym, not in
   the standard service-word stop list, judged after
   normalization/stemming); M5–M6 asked for **at least one**. If no skill
   covers enough, `search()` returns `[]` — the MCP `find` turns that into
   `{"ok":true,"items":[],"note":"ничего не найдено"}` and the plugin hint
   simply emits no block (both call the same `search()`).
3. **Relative noise floor** (see M5 § Threshold below; re-derived in M6) —
   **abolished in M7**, see § M7.

M6 amended steps 1–2: words are token-level (`next.js` stays one word, a
hyphen splits), `why` attributes a field by token equality, and upper-case
short acronyms became meaningful — see § M6.

**M7 amended step 2 and removed step 3**: the stop list became the standard
service-word list, and "at least one matched token" became the **coverage
rule** `matched ≥ min(2, N)`; the score floor (`MIN_STRENGTH` +
`corpusCeiling`) is gone — see § M7.

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

## M5 § Threshold (relative noise floor) — HISTORICAL, abolished by M7

> **M7 status:** this section and § M6 § Threshold describe a mechanism that
> **no longer exists**: M7 deleted `MIN_STRENGTH` and `corpusCeiling` and
> replaced the floor with the coverage rule (§ M7 § Rule). Kept verbatim as
> the record of how the 0.7 value was derived while it existed.

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

### M6 § Threshold (MIN_STRENGTH re-derived) — HISTORICAL, abolished by M7

> **M7 status:** the mechanism below was deleted in M7 (coverage rule, § M7).
> Kept verbatim as the record of the last derivation done while it existed.

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

## M7 § Standard stop list + coverage rule (threshold removed)

### The rule (the whole validation story now)

Two changes, both task-driven, no measurement behind either of them:

1. **Stop list → the standard service words** (`core/text.mjs`
   `RAW_STOP_WORDS`, folded through the same `normalizeTerm` as the query
   side): English *when what which who whom whose why how should would could
   can will shall may might must do does did done is am are was were be been
   being this that these those there here then than so such just very also
   about into over under after before between again more most some any all no
   not only own same too up down out off i me my we us our you your he she it
   they them their its and or but if because as at by from in of on to with
   without next new using use* + Russian *когда что какой какие как почему
   зачем где кто чтобы если или но а же ли бы для при без под над про через
   между после перед также уже ещё очень только надо нужно можно есть был
   была было были будет этот эта это эти тот та то те мой моя моё мои наш
   наша наше наши свой своя свои самый*. The short M5/M6 list (`a an the for
   и в во на по с со к о об от до за из не`) is a **subset** — nothing was
   removed, the set only grew. Subject words are not in it: *review, check,
   audit, policy, contract, договор, проверь, аудит, политика* stay
   significant (tested). Exception kept from M6: a whitelisted **upper-case
   acronym** (`IT`) stays meaningful — case still separates it from the
   pronoun `it`, which is a stop word.

2. **Coverage rule instead of `MIN_STRENGTH`** (`core/index.mjs`): with
   `N` = number of significant query tokens, a result is valid iff it matches
   by token equality at least `min(2, N)` of them; otherwise the answer is
   `[]` → MCP `find` `{ok:true, items:[], note:"ничего не найдено"}` and no
   plugin block — one rule for both consumers. `MIN_STRENGTH`, `BM25_SATURATION`
   and `corpusCeiling` were **deleted**, so no score threshold exists: scores
   only order the list, they never decide whether it is returned.

**Why 2:** one shared word does not prove a topic — that is precisely how the
junk AC3 queries got answers (a lone «office», a lone «when»); two matched
tokens are the minimal sign that a skill really speaks about the request. A
query of 1–2 meaningful tokens is proven by one of them (`min(2, N)`), so a
short precise query («договор», «zebra») is never over-tightened; `N = 0`
(service words only) has nothing to prove with → `[]`. This is a *rule* with
a stated rationale, not a value fitted to a measured gap — nothing here has to
be re-derived when the corpus or the query set changes.

### M5 → M6 → M7 (set A, same commands)

| metric | M5 | M6 | **M7** |
|---|---|---|---|
| easy recall@5 / all@5 | 0.7714 / 0.7714 | 0.7714 / 0.7714 | **0.7714 / 0.7714** |
| easy NDCG@10 | 0.6660 | 0.6660 | **0.6814** |
| hard recall@5 / all@5 | 0.6000 / 0.2667 | 0.6000 / 0.2667 | **0.7333 / 0.2667** (11/15 vs 9/15) |
| hard NDCG@10 | 0.4996 | 0.4996 | **0.5349** |
| ALL recall@5 / all@5 | 0.7200 / 0.6200 | 0.7200 / 0.6200 | **0.7600 / 0.6200** |
| ALL NDCG@10 | 0.6161 | 0.6161 | **0.6375** |
| AC3 non-empty | 2/10 (#58, #59) | 2/10 (#58, #59) | **0/10 — 10/10 closed** |
| draft set (28) product recall@5 | 0.9643 (27/28, MISS #13) | 0.9643 (27/28, MISS #13) | **1.0000 (28/28)** |
| warm search p95 | 1.68 ms | 2.38 ms | **2.14 ms** |
| weights winner | 3/2/1 | 3/2/1 | **3/2/1 (re-run, same winner; no candidate beats it)** |
| score threshold | `MIN_STRENGTH`=0.7 | 0.7 | **none (deleted)** |

Product recall@5 stays ≥ baseline in every row (0.7600 vs 0.7000).

### Answers gained / lost (the mandatory honesty check)

Compared **per query** against the M6 run (temporary `_m7_state.mjs`, the
exact `search()` call, same 365-skill index; before/after dumps kept only in
the report, script deleted):

- **Lost (had qrels, became empty): NONE.** No query answered in M6 returns
  `[]` in M7 — the coverage rule removed no relevant answer on set A. Also
  **no query went hit@5 → MISS and none lost its qrel from the top-10.**
- **New hits@5 (this is the hard-recall jump 0.6000 → 0.7333, 9/15 → 11/15):**
  #38 «Мы продаём долю в ООО — проверь черновики документов…»
  (`share-deal-review` at rank 4) and #48 «Extract all dates, amounts and
  owners from the batch of incoming contracts…» (`tabular-review` at rank 4)
  — the coverage filter drops non-covering leftovers, so the real answer
  rises into the top-5 instead of being crowded out.
- **Top-10 gain:** #28 «From my last git history pull out real
  achievements…» — `star-story-extractor` moved from outside the top-10 into
  it (NDCG effect; still not top-5, so not a recall change).
- **Were `[]` under the M6 floor, now return a list — but still miss (no
  metric change, they were misses before too):** #4 (→ renewal-tracker,
  construction-contract-review; qrel `pretensia-draft` not in top-10),
  #40 (→ video-promo; qrels not in top-10), #47 (→ ai-usage-rules, cold-
  start-interview-ai-governance …; both qrels not in top-10). **#47 stated
  plainly:** its qrels overlap the query on ONE meaningful token (`ai`) out
  of nine, so `min(2, 9) = 2` cuts them — the M6 floor cut them too (as `[]`),
  so this is not a regression, but the coverage rule does **not** rescue
  #47 either; reported as a known limitation of the rule, not tuned away.
- **Still empty with qrels: #14 only** («Найди, почему сайт грузится дольше,
  чем надо», qrel `performance-optimization`): it was already `[]` in M6 (by
  the floor) and stays `[]` in M7 because no skill covers 2 of its five
  meaningful tokens (`найд, сайт, грузитс, дольш, чем`). It was a miss in M6
  too — no metric moved because of it.
- AC3 #58/#59: their service words (`when`, `next`, `what`, `should`) are
  stop words now and their topic words (`bus`, `airport`, `coffee`, `buy`)
  occur in no skill text — both are cut at the gate, not by a floor.

### Checks run for M7

`npm test` → 92 tests, 91 pass, 1 skipped (symlink EPERM, unchanged),
0 fail. `node measure/run.mjs`, `node measure/latency.mjs` (p95 2.14 ms),
`node measure/weights.mjs` (winner unchanged), draft set 28 → 1.0000.

## M8 § Acceptance set B (independent, delayed)

Set B (`measure/heldout-b.jsonl`, 60 queries: 30 easy / 20 hard / 10 empty)
was committed **before** any measurement (`M8: acceptance query set B
(independent)`, commit `6a347a7`) and is the ACCEPTANCE set: it was built by an
independent agent, never seen while tuning. After the first B run nothing in
the product was touched — no weights, stop words, stemmer, coverage rule or
tokenization change. The numbers below are as measured, including where they
are worse than on set A.

`--set <path>` was added to `run.mjs` (default still `measure/heldout.jsonl`;
the methodology — metrics, eligibility rule, AC3 block — is identical for any
set). Command: `node measure/run.mjs --set measure/heldout-b.jsonl`.

### Set B results (product P vs baseline B)

| kind | n | P recall@5 | P all@5 | P NDCG@10 | B recall@5 | B all@5 | B NDCG@10 |
|---|---|---|---|---|---|---|---|
| easy | 30 | 0.7667 | 0.7667 | 0.6862 | 0.9000 | 0.9000 | 0.7357 |
| hard | 20 | 0.7500 | 0.3500 | 0.5500 | 0.7500 | 0.3000 | 0.5524 |
| empty | 10 | n/a | n/a | n/a | n/a | n/a | n/a |
| **ALL(qrels)** | 50 | **0.7600** | **0.6000** | **0.6317** | **0.8400** | **0.6600** | **0.6624** |

- **AC2 on B: FAIL** — product recall@5 0.7600 < baseline 0.8400 (38/50 vs
  42/50). On easy the gap is widest (0.7667 vs 0.9000); hard is a tie
  (0.7500 vs 0.7500). Set A still shows the opposite (0.7600 vs 0.7000, YES).
- **AC3 on B: FAIL** — 3 of 10 empty queries returned a positive-scoring
  result: #53 → `rag-kit:76.855`, #56 → `copy-editing:94.825`, #57 →
  `landing-page-copy:255.232, direct-response-copy:236.414, …` (set A: 0/10).
- missing qrels: none; all 50 qrel-bearing queries eligible.

### Set A vs set B (same code, same day)

| metric | set A (validation) | set B (acceptance) |
|---|---|---|
| easy recall@5 / all@5 | 0.7714 / 0.7714 | 0.7667 / 0.7667 |
| hard recall@5 / all@5 | 0.7333 / 0.2667 | 0.7500 / 0.3500 |
| ALL recall@5 / all@5 | 0.7600 / 0.6200 | 0.7600 / 0.6000 |
| ALL NDCG@10 | 0.6375 | 0.6317 |
| product ≥ baseline (AC2) | YES (0.7600 vs 0.7000) | **NO (0.7600 vs 0.8400)** |
| AC3 non-empty | 0/10 | **3/10 (#53, #56, #57)** |
| warm search p95 | 2.14 ms (M7) | 2.55 ms (same run day, 2.55/2.34 ms) |

The set-A re-run reproduced M7 exactly (easy 0.7714 / hard 0.7333 / all 0.7600
/ all@5 0.6200 / NDCG 0.6375 / AC3 0/10), so the A↔B gap comes from the query
distribution, not from a code change.

### Misses on set B (12 of 50; product top-3)

| # | kind | query | qrels | product top-3 |
|---|---|---|---|---|
| 3 | easy | выбрать режим налогобложения для ИП | tax-system-choice | `[]` (empty) |
| 9 | easy | убрать фильм с пиратского сайта | takedown | `[]` (empty) |
| 10 | easy | удалить мои данные из фирмы | dsar-response | `[]` (empty) |
| 12 | easy | review teammate PR before merge | code-review-and-quality | git-workflow-and-versioning, finishing-a-development-branch |
| 18 | easy | pick easing between app screens | motion-design | redesigner, landing-page, logo-design |
| 19 | easy | pull competitor palette and fonts | redesigner | refactoring-ui |
| 23 | easy | У нас чат-бот отвечает клиентам… | user-disclosure-check | dpa-review, google-search, rag-kit |
| 32 | hard | Before we promote the CV-screening model… | ai-inventory, deployment-review | foreman, edge-case-auditor, n8n-self-hosting |
| 37 | hard | The offer letter our recruiter drafted… | hiring-review, escalation-flagger | security-and-hardening, cover-letter-writer, logo-design |
| 41 | hard | Onboarding a politically connected wealthy client… | kyc-procedure, pep-screening | email-and-password-best-practices, two-factor-authentication-best-practices, n8n-self-hosting |
| 48 | hard | Сначала дизайн-план лендинга… | direction, build-recipes | publisher-regression-guard, inspection-preparation, app-visual-design |
| 49 | hard | Возьмите наш живой лендинг и дотяните… | elevate, verify | rustore-release, vat-analysis, inspection-defense |

Three easy misses (#3, #9, #10) returned **nothing at all** — the coverage
rule cut every candidate; five hard misses lose one of two qrels each (their
`all@5` is what drags 0.3500). Reported as measured; no tuning followed.

### Checks run for M8

`npm test` → 92 tests, 91 pass, 1 skipped (symlink EPERM, unchanged), 0 fail.
`node measure/run.mjs` (set A) → matches M7. `node measure/run.mjs --set
measure/heldout-b.jsonl` (human + `--json`). `node measure/latency.mjs` →
warm p95 2.55 ms (search) / 2.34 ms (hint path), first call 370.14 ms.

## M9 § Informative tokens (IDF-lite) + typo tolerance

Task-driven fix for the two failure shapes diagnosed on set B after M8: short,
precise queries answered with `[]` (#3 «выбрать режим налогобложения для ИП»),
and junk queries covered by COMMON words (#53/#56/#57). Two additions to the
coverage rule (`core/index.mjs`, `core/text.mjs`); no change to sets, field
weights, stemmer or tokenization.

### The rule

1. **Only rare tokens count toward coverage (IDF-lite).** A significant query
   token counts as a match only when it is rare in the corpus:
   `df <= 8% of the skills`. On the 365-skill corpus
   `rareDfMax(365) = max(3, floor(0.08 × 365)) = 29 documents`. The rule is
   `need = min(2, N_informative)` — the M7 rule with `N` narrowed to the
   informative tokens; `N_informative = 0` (only common words left) answers
   `[]`, which the MCP `find` reports with its standard
   `{ok:true, items:[], note:"ничего не найдено"}` (no new note path).
   Common words are NOT removed from the query: they still hit the BM25 index
   and still **rank** the list — they just can no longer **validate** it.
   Two details worth stating:
   - **df scope = the indexed corpus** (`name + description + headings`) — the
     same text search reads and coverage matches, so a rare term really
     narrows the searchable skills (see the scope section below);
   - **an unseen token borrows the df of its closest match**: for a token with
     `df = 0` (typically a misspelling) the effective df is the minimum df of
     its distance-1 neighbours, so a typo of a common word cannot launder its
     way into coverage as a "rare" token;
   - **small corpora**: 8% of fewer than 38 skills is under 3 documents, so
     the ceiling is floored at 3 documents (`MIN_RARE_DF`). Without the floor
     every word shared by two fixture skills would be "common" and a 2-token
     query could never be covered. On the real corpus the floor is inert
     (3 < 29).

2. **One typo for long tokens.** A query token of length ≥ 6 may match a
   corpus term at Levenshtein distance ≤ 1 (one insertion, deletion or
   substitution — `withinOneEdit`, O(len) with early exit, tested). The
   candidates come from an index over corpus terms keyed by **first letter and
   length**, and only the neighbouring buckets (`len-1`, `len`, `len+1`) are
   consulted — no O(vocabulary × query) scan. The typo match counts for
   coverage and is shown in `why` prefixed with `≈`
   (`matched name+description: режим, ≈налогообложен`). Tokens shorter than 6
   are exact-only («сайта» is never turned into «сайт» by this path — that
   folding, where it happens at all, is the M5 stemmer), and **one** typo per
   token is the limit («wrokflow» ∌ «workflow»: a transposition is two edits).

### Why 8% — the df distribution behind the ceiling

`df` over the indexed corpus: **6694 distinct terms** in 365 skills;
the ceiling is `29 documents = 8.0% of the skills`.

| df (skills containing the term) | terms | share of vocabulary |
|---|---|---|
| 1 | 3394 | 50.7% |
| 2 | 1120 | 16.7% |
| 3–5 | 1145 | 17.1% |
| 6–15 | 723 | 10.8% |
| 16–29 (rare, ≤ ceiling) | 181 | 2.7% |
| 30–73 (common) | 91 | 1.4% |
| 74–146 (common) | 28 | 0.4% |
| 147+ (common) | 12 | 0.2% |
| **total / above ceiling** | **6694 / 131** | **100% / 2.0%** |

Only **2.0% (131 terms)** of the vocabulary is that generic — and it is
exactly the glue: `use(200), when(175), workflow(156), a(155), to(151),
the(149), для(147), юридическ(145), and(144), disclaimer(143), or(139),
output(134), шаг(133), назначен(126), skill(125), не(120)…`. Everything below
the ceiling (98.0%) is genuine topic vocabulary: `договор(26), сервис(12),
загрузить(3), подрядчик(1)…`. The ceiling therefore does not clip topical
words at corpus scale: on set A, **22 of 398 significant query tokens (5.5%,
14 distinct words)** cross it — `review(83)×4, проверк(38)×3, need(41)×3,
ai(40)×2, срок(36), framework(34), step(52), draft(36), check(69),
design(41), system(30), code(40), data(38), proc(43)`.

### df scope: indexed corpus vs whole SKILL.md (the one judgment call)

«Corpus» is ambiguous here, and the two readings were both measured on set A:

| df counted over… | «документы» | «данные» | «сайт» | «работы» | set A easy/hard/all recall@5 | AC2 on A |
|---|---|---|---|---|---|---|
| indexed fields (name+desc+headings) — **committed** | 24 rare | 11 rare | 6 rare | 19 rare | **0.7429 / 0.6667 / 0.7200** | YES (0.72 ≥ 0.70) |
| whole SKILL.md (frontmatter + body) — measured, rejected | 88 common | 161 common | 28 rare | 68 common | 0.4286 / 0.2000 / 0.3600 | **NO** (0.36 < 0.70) |

The whole-file reading matches the examples in the M9 brief
(«документы», «данные», «работы» are common there; «сайт» stays rare in BOTH
readings — 28 ≤ 29), but it declares generic every word that merely appears
somewhere in a body while being searchable in only a handful of skills
(«работы»: 68 bodies, 19 searchable texts) and collapses retrieval to 0.3600.
The committed scope keeps df calibrated to the text where a match can actually
happen. **This is the one interpretation decision of M9** — switching it is a
one-line change in `buildIndex`, both measurements are recorded above so the
choice can be re-taken knowingly.

### M7 → M9 (set A, same commands)

| metric | M7 | **M9** |
|---|---|---|
| easy recall@5 / all@5 | 0.7714 / 0.7714 | **0.7429 / 0.7429** (26/35, −1) |
| easy NDCG@10 | 0.6814 | **0.6529** |
| hard recall@5 / all@5 | 0.7333 / 0.2667 | **0.6667 / 0.3333** (10/15, −1; all@5 4/15 → 5/15) |
| hard NDCG@10 | 0.5349 | **0.4835** |
| ALL recall@5 / all@5 | 0.7600 / 0.6200 | **0.7200 / 0.6200** (36/50, −2) |
| ALL NDCG@10 | 0.6375 | **0.6021** |
| AC2 (product ≥ baseline on A) | YES (0.7600 vs 0.7000) | **YES (0.7200 vs 0.7000)** |
| AC3 non-empty | 0/10 | **0/10** |
| draft set (28) recall@5 | 1.0000 (28/28) | **0.8929 (25/28)** |
| warm search p95 | 2.14 ms | **3.79 ms** (hint path 2.77 ms; budget 150 ms) |
| weights winner | 3/2/1 | **3/2/1 (unchanged)** |
| tests | 92 (91 pass) | **102 (101 pass, 1 skipped symlink)** |

**The three set-A targets in the M9 brief (≥0.7714 / ≥0.7333 / ≥0.7600) are
NOT met — shown, not masked.** Every point of the drop is the specified rule
doing what it says: a query hit lost its SECOND covered token because that
token is common:

- **#33 «Design a logo for my coffee shop»** (easy, was hit → now `[]`):
  `logo-design` matched `design(41) + logo(4)` under M7; `design` = 41/365 =
  11.2% > 8%, so it stops counting and only `logo` remains (1 < 2).
  `near(coffee) = ∅` — no typo candidate rescues it.
- **#44 «The UI is messy and the code behind it is tangled…»** (hard, was hit
  → now `[]` at the top): `refactoring-ui` matched `ui(15) + code(40)`;
  `code` = 11.0% > 8% stops counting (1 < 2), while `tailwindcss` and
  `browser-testing-with-devtools` (both `ui + clean`) legitimately pass —
  they carry two rare tokens.
- **#49 «Review the data processing addendum…»** (hard): `review(83),
  data(38), proc(43)` are all common → left the top-10 (NDCG effect; it was
  already a non-hit).

Per-query diff M7 → M9 over all 50 qrel queries (temporary `_m9_diff.mjs`,
deleted after the run, dump kept in `writer-report.md`): **23 unchanged, 27
changed, 2 hits lost (#33, #44), 0 hits gained, 3 qrels left the top-10
(#33, #44, #49), 2 queries became `[]` (#33, #49)**. No query went
MISS → hit. The one positive movement is on `hard all@5`
(0.2667 → 0.3333): #41's second qrel `security-audit` rises into the top-5
once non-covering leftovers are cut — the same mechanism M7 reported.

### Draft set (28, `measure/queries.jsonl`): regression, itemized

1.0000 → **0.8929 (25/28)**; all three misses are common-token cuts
(temporary `_m9_draft.mjs`, deleted after the run):

- **#1 «review a commercial contract»**: `review(83)` stops counting;
  `contract-review` holds `contract(26)` + `review` → 1 < 2 (and its
  «коммерческог» is the Russian word, not the query's `commercial`).
- **#7 «draft a non disclosure agreement NDA»**: `draft(36)` stops counting;
  `nda-draft` holds `nda(7)` only of the informative set → 1 < 2.
- **#13 «debug failing test systematically»**: `test(30)` stops counting;
  `debugging-and-error-recovery` holds `fail(9)` (+ `test`) → 1 < 2, and
  `systematic-debugging` holds `test` + `failure` (≠ `fail`) → 0.

### Checks run for M9

`npm test` → 102 tests, 101 pass, 1 skipped (symlink EPERM, unchanged),
0 fail — including 10 new M9 tests (rarity ×3, typo ×4, `withinOneEdit` ×3).
`node measure/run.mjs` (set A, table above; AC3 0/10). `node measure/latency.mjs`
(search p95 3.79 ms, hint p95 2.77 ms, index build 402.78 ms, first call
643.36 ms). `node measure/weights.mjs` → winner `name 3 / desc 2 / headings 1`
unchanged, no candidate beats it. Draft set 28 → 25/28 (itemized above).
Set B was NOT re-run (acceptance set, off-limits after M8).

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
node measure/run.mjs --set measure/heldout-b.jsonl  # same metrics on set B (M8)
node measure/weights.mjs  # field-weight candidates on set A (M5)
node measure/latency.mjs  # p50/p95/max + first-call (index build)
node measure/baseline.mjs --k 5 --verbose   # standalone baseline on the draft set
```

Numbers in the M4 report come from these commands, run **once**; numbers in the
M5 report are the same commands re-run after the M5 changes, with the before/after
table kept in `writer-report.md`. If a metric is below the baseline, it is
reported as is — the set is never adjusted.

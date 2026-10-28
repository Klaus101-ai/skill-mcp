# skill-mcp — product contract

Source of truth: the product specification (`spec.md` §5 R1–R6, §6 tool
contracts, §7 hint contract), owner decisions of 25.10.2026 (§4), the owner
decision of 26.10.2026 to split search from the hint (v0.3: `find` returns the
full list with a `confident` flag), the owner decision of 26.10.2026
«Передавай» / «5 кандидатов» (v0.4: the hint and `find` present **up to 5
candidates**, confident first, unconfirmed ones marked «(возможно)» —
the MCP no longer claims a single answer) and the
owner decision of 26.10.2026 choosing **variant G** of the variants lab
(v0.4.1: query expansion + `BOOST_ORDER` domain boost inside `search()`,
tool-silence + confident gate in the hint, `find` default limit 10 — the
lab's G behaviour ported verbatim, metrics in `measure/README.md` § v0.4.1).
Owner task 27.10.2026 (**v0.6.2**): the note now tells the agent to read the
candidate descriptions and load the matching skill, and every non-empty
`find` answer carries a top-level `next`.
The English text below is a faithful summary; where the specification wording
matters, the original Russian text is quoted verbatim. Companion to
the [README](../README.md).

## R1–R6 (requirements)

**R1 — the hint never claims a skill is loaded.** The block always carries the
wrapper below (v0.6.2 note wording, owner task 27.10.2026).

> **R1.** Подсказка НИКОГДА не утверждает, что скилл загружен; формулировка вида
> `<skill_hint source="skill-router" note="посмотри описания кандидатов; если один подходит — загрузи его через skill; если нет — не загружай.">`.

**R2 — allow/deny is the plugin config; default is everything except the
forbidden list** (redaction per the owner's decision, spec §4 п. 5).

> **R2.** Подсказка соблюдает allowlist имён скиллов (редакция по решению владельца, §4, п. 5):
> подсказываются любые скиллы, кроме запрещённых списком в конфиге плагина.

**R3 — the hint does not replace the lead's mandatory «Скиллы» field.**

> **R3.** Подсказка НЕ заменяет обязательное поле «Скиллы» в ответе лида и не считается
> его выполнением.

**R4 — the hint does not affect the skill-gate lock.**

> **R4.** Подсказка не влияет на замок skill-gate: гейт считает только реальные вызовы
> инструмента `skill`.

**R5 — fully local, read-only.**

> **R5.** Полностью локально: без сети, LLM, ключей, телеметрии; чтение файлов скиллов —
> только чтение.

**R6 — fail-open and the hint budget.**

> **R6.** Fail-open: любой сбой подсказки не ломает сессию; выключение одной env-переменной
> убирает подсказку целиком; бюджет — не более 1000 символов, не более 2 позиций,
> не более 150 мс.

v0.4 amendment (owner decision 26.10.2026): the position budget is **5
candidates** instead of 2; 1000 chars and 150 ms are unchanged.

v0.4.1 amendment (owner decision 26.10.2026, variant G): the budgets stay
exactly as above (≤5 / ≤1000 / ≤150 ms — G does not widen them, the lab's
10-entry option was NOT chosen); what changed is WHEN a block forms: a
**tool-silence** check (a complaint about the plugin/router/MCP itself → no
block) and a **confident gate** (no `confident:true` position in the
top-10 pool → no block) run before the budget is even spent. The R6 budgets
for a possible 10-entry variant remain an owner-open question (lab §8 (б)).

## Hint block format

Mandatory wrapper (R1, verbatim, v0.6.2 note):

```text
<skill_hint source="skill-mcp" note="посмотри описания кандидатов; если один подходит — загрузи его через skill; если нет — не загружай.">
- <skill-name>: <one line why>; открыть: инструмент skill, name=<skill-name>
- <skill-name> (возможно): <one line why>; открыть: инструмент skill, name=<skill-name>
</skill_hint>
```

- up to **5 candidates** (v0.4, owner decision 26.10.2026: «5 кандидатов»);
  each candidate = skill name, one «why» line taken from `description` (first
  line, ≤120 chars), and how to open it (`skill` tool, `name=…`);
- **confident first**: `confident:true` positions (≥ `min(2, N)` significant
  query tokens covered) always precede `confident:false` ones (the v0.3.1
  order of `search()`); a candidate that did not pass the coverage rule is
  marked **«(возможно)»** right after its name — the marker names the
  uncertainty instead of hiding the candidate. v0.4.1 exception: the domain
  boost of `search()` runs after that order on `BOOST_TRIGGER` queries and
  may move a `BOOST_ORDER` name to position 1 (measured: it is `confident`
  on Q1/Q3 anyway);
- **two silences before the block (v0.4.1, variant G)**:
  1. **tool-silence** — the query matches BOTH a tool word
     (`плагин|skill-router|skill-mcp|mcp`) and a complaint word
     («почему|не нашел|не нашёл|не активировал|не работает») → no block: the
     model answers the user's question about the tool, candidates would be
     noise;
  2. **confident gate** — the pool (the top-10 of `search()`) contains no
     `confident:true` position → no block. Unconfirmed candidates may appear
     only behind at least one proven one (still marked «(возможно)»);
- **the block states candidates, never a single answer**: the note instructs
  verbatim «посмотри описания кандидатов; если один подходит — загрузи его
  через skill; если нет — не загружай.» — read the candidate descriptions,
  load the one that matches, load nothing when none fits. AC3
  («no random hints») is therefore rephrased as **«кандидаты, не утверждение»**
  — the block must present options, not assert which skill is THE one; a
  hint block forms as long as the search found anything that survives
  deny/allow and the name/description sanity checks AND the two silences
  above pass;
- the whole block **≤ 1000 characters** (R6) ≈ ≤ 250 tokens (chars / 4; the
  lab's Cyrillic/3 + Latin/4 estimate for a typical 4-entry block: ~194–202
  tokens); if the 5th candidate does not fit, the tail is **dropped** (the
  block keeps what fits — it is never replaced by an empty block);
- forbidden: claiming the skill is loaded/opened (R1); quoting skill bodies;
  more than 5 candidates or 1000 chars; asserting one candidate as the
  answer; passing itself off as the «Скиллы» field or its execution (R3);
  generating any tool call, including `skill` (R4); reading files outside the
  skill roots; network, LLM, keys, telemetry (R5).

Default behaviour (owner decision §4 п. 5): every skill is hintable except the
agent's `deny` list in the plugin config; an `allow` list per agent narrows it
to those names. The hint acts in all sessions, including subagents (§4 п. 6).

## Tool contracts (MCP server, stdio / JSON-RPC 2.0)

Common: every answer is a JSON object `{ok, …}`; every error is
`{ok:false, error:{code, message}}`; all tools read files only inside the
skill roots after resolving the canonical path (path traversal is refused —
AC4).

### `find`

v0.3 (owner decision 26.10.2026 — search split from the hint), v0.4
(candidate list) and **v0.4.1 (variant G)**: `find`
returns **up to `limit` candidates** (**default 10** since v0.4.1); the
coverage rule does not filter the list and only flags each position, every
item carries the skill `description` so the model can judge the candidates
without extra calls, and the query goes through the G pipeline inside
`search()` (see «Query processing» below) — `find` receives expansion and
domain boost automatically.

Tool description (v0.6.2): it leads with «Call this FIRST», says the call
returns a shortlist with each skill's description, tells the model to **read
the descriptions and choose the skill that matches**, to verify a
`confident:true` likely match against its description, and to **load the
chosen skill with the `skill` tool before answering** — or proceed without a
skill when no candidate matches.

| | |
|---|---|
| Input | `query: string` (required), `limit?: integer` (default **10** since v0.4.1, **max 10**), `restrict_to?: string[]` (skill-name / glob allowlist filter) |
| Answer | `{ok:true, items:[{name, path, score, why, description, confident}], next}` sorted by descending `score` (confident first); `why` — one line, ≤160 chars; `description` — the skill's frontmatter description ("" when absent); `confident: boolean` — the position covers ≥ `min(2, N)` significant query tokens (N = the number of the EXPANDED query's meaningful tokens — v0.4.1), i.e. it is a proven rather than a possible candidate; `next` (top-level, since v0.6.2) — `likely match: <name> — verify its description and load it` when the first item is `confident:true`, otherwise `review the candidate descriptions; load the matching skill`; empty results carry no `next` (there is nothing to review) |
| Index fields | `name` (×3), `description` (×2), `headings` (×1), **`aliases` (×1)** — the v0.2 bilingual bridge: RU↔EN dictionary equivalents of the document's own terms, written at index time from the static `core/lexicon.ru-en.json` (local file only, no network/LLM, R5); the confidence rule (≥`min(2, N)` significant tokens by token equality) applies to alias matches like any other token, except the weak pairs listed in `core/lexicon.ru-en.json` under `_weak` — those rank but never count toward confidence (v0.2.1) |
| Query processing (v0.4.1, G) | inside `search()`: **expansion** — a query containing «описан…» appends «текст», «продукт…» appends « product» (`expandQuery`); tokens, the `confident` coverage check and `why` run on the EXPANDED query; **domain boost** — when the ORIGINAL query matches `BOOST_TRIGGER` = `описан\|текст\|лендинг\|копирайт\|продукт`, the capped pool is reordered so `BOOST_ORDER` = promo, copywriting, site-copywriting, app-copywriting, documentation-and-adrs, redpolitika leads it (`boostReorder`) — **reorder only, no additions**; the name list is hardcoded (owner-open question, README §8) |
| Limits | ≤10 items; ≤1 `why` line per item; other fields truncated |
| Empty query | `{ok:true, items:[], note:"пустой запрос"}` |
| No hits at all | `{ok:true, items:[], note:"ничего не найдено"}` |
| Hits, none confident | `{ok:true, items:[{…, confident:false}, …], note:"уверенных нет, вот возможные"}` — the candidate list is still returned (v0.3/v0.4) |
| Errors | `E_INVALID_INPUT` (not a string, `limit` outside 1–10 — rejected, not clamped), `E_UNAVAILABLE` (skill directory unavailable / index not built; the call fails, opencode still starts) |

**AC3 caveat (v0.4 rephrasing, owner decision 26.10.2026).** AC3 —
«no random hints» — is now **«кандидаты, не утверждение»**: both consumers
present candidates rather than asserting an answer. The `find` output is a
ranked candidate list (`confident` per item, `note` when nothing is
confident, `next` telling the agent to verify and load); the plugin hint
shows the same candidates (≤5, «(возможно)» on unconfirmed ones) and its
note reads verbatim «посмотри описания кандидатов; если один подходит —
загрузи его через skill; если нет — не загружай.» — read the descriptions,
load the matching skill, or load nothing when none fits.

### `outline`

| | |
|---|---|
| Input | `name: string` (skill name) **or** `path: string` (checked to be inside a skill root) |
| Answer | `{ok:true, name, path, description, headings:[{level, text, line}]}` — frontmatter plus H1–H3 headings with line numbers |
| Limits | ≤40 headings, ≤150 answer lines; overflow → cut from the bottom and `truncated:true` |
| Errors | `E_INVALID_INPUT` (empty/missing input), `E_NOT_FOUND` (unknown skill), `E_FORBIDDEN` (outside the skill roots) |

### `read-section`

| | |
|---|---|
| Input | `name: string` (required), `heading: string \| integer` (heading text without `#`, or its number in `outline` order), `max_lines?: integer` (default 150, **max 600**) |
| Answer | `{ok:true, name, heading, line_start, lines:[...], truncated:boolean}` — from the heading to the next heading of the same level |
| Limits | ≤600 lines per answer; longer sections truncated with `truncated:true` |
| Errors | `E_INVALID_INPUT`, `E_NOT_FOUND` (skill), `E_SECTION_NOT_FOUND` (heading), `E_FORBIDDEN` (outside the skill roots) |

Transport-level JSON-RPC codes (not tool-level): unknown tool `-32602`,
unknown method `-32601`, malformed line `-32700`, invalid request `-32600`,
unexpected failure `-32603`.

## Safety guarantees

- **Read-only**: the product never writes, moves or deletes any file; the
  index is built in memory from `SKILL.md` frontmatter and headings.
- **No network**: no HTTP, no LLM, no embeddings, no API keys, no telemetry
  (R5) — the MCP server talks stdio, the plugin runs BM25 over the local
  index.
- **Root boundary**: every path is resolved to its canonical real path
  (realpath) and must stay inside one of the skill roots; anything outside is
  refused with `E_FORBIDDEN` (`resolveSkillPath` in `core/sources.mjs`,
  symlink escapes reported as `skipped: outside-root`).
- **No side effects in opencode**: the plugin appends exactly one `system`
  text part per request (≤5 candidates, ≤1000 chars) and touches nothing else —
  messages, history, tools and options are unchanged; it never calls the
  `skill` tool, so it cannot create skill-gate events (R3, R4).
- **Fail-open** (R6): any internal error drops the hint instead of failing the
  request; `SKILL_MCP_HINT=off|0|false` removes the hint completely (the legacy
  `SKILL_ROUTER_HINT` name is deprecated since v0.5.0 and still works as a
  fallback when the new variable is unset; with both set, `SKILL_MCP_HINT`
  wins).
- **No LLM / no embeddings / no network, still true for v0.4.1**: the G
  expansion and boost are two regexes and one hardcoded name list inside
  `core/index.mjs` — no model call, no external data, read-only local files
  (R5; `test/safety.test.mjs` keeps scanning core for network imports).

## Owner-open questions (variants lab §8 — carried over, NOT decided here)

1. Is a **hardcoded domain list** acceptable in the product (`BOOST_ORDER`,
   variant G)? — «допустим ли в продукте зашитый доменный список скиллов (G)».
2. Should the **R6 budget (1000 chars)** be re-derived if a 10-entry variant
   is ever chosen? — G keeps 5 entries, so the budget is unchanged; the
   question stays open for any future widening.
3. Should the **tool-rule vocabulary** be extended, or `/скилл/` softened to
   `/скил/` (variant D's fragility: the owner's Q1 wrote «скилы» with one
   «л»)? — v0.4.1 ships the lab's G regexes verbatim; no vocabulary change
   was made unilaterally.

# skill-router — product contract

Source of truth: the product specification (`spec.md` §5 R1–R6, §6 tool
contracts, §7 hint contract), owner decisions of 25.10.2026 (§4) and the owner
decision of 26.10.2026 to split search from the hint (v0.3: `find` returns the
full list with a `confident` flag, the hint is built from `confident:true`
only). The English text below is a faithful summary; where the specification
wording matters, the original Russian text is quoted verbatim. Companion to
the [README](../README.md).

## R1–R6 (requirements)

**R1 — the hint never claims a skill is loaded.** The block always carries the
wrapper below.

> **R1.** Подсказка НИКОГДА не утверждает, что скилл загружен; формулировка вида
> `<skill_hint source="skill-router" note="подсказка, не загрузка: скилл не открыт">`.

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

## Hint block format

Mandatory wrapper (R1, verbatim):

```text
<skill_hint source="skill-router" note="подсказка, не загрузка: скилл не открыт">
- <skill-name>: <one line why>; открыть: инструмент skill, name=<skill-name>
</skill_hint>
```

- at most **2** positions (R6); each position = skill name, one «why» line
  taken from `description`, and how to open it (`skill` tool, `name=…`);
- **candidates come from `confident:true` search positions only** (v0.3,
  owner decision 26.10.2026): `confident` = ≥ `min(2, N)` significant query
  tokens covered, the former shared gate; a result list without a single
  confident position produces **no block at all** — this is where AC3
  («no random hints») is binding, as opposed to the full `find` output;
- the whole block **≤ 1000 characters** (R6) ≈ ≤ 250 tokens (chars / 4);
- forbidden: claiming the skill is loaded/opened (R1); quoting skill bodies;
  more than 2 positions or 1000 chars; passing itself off as the «Скиллы»
  field or its execution (R3); generating any tool call, including `skill`
  (R4); reading files outside the skill roots; network, LLM, keys, telemetry
  (R5).

Default behaviour (owner decision §4 п. 5): every skill is hintable except the
agent's `deny` list in the plugin config; an `allow` list per agent narrows it
to those names. The hint acts in all sessions, including subagents (§4 п. 6).

## Tool contracts (MCP server, stdio / JSON-RPC 2.0)

Common: every answer is a JSON object `{ok, …}`; every error is
`{ok:false, error:{code, message}}`; all tools read files only inside the
skill roots after resolving the canonical path (path traversal is refused —
AC4).

### `find`

v0.3 (owner decision 26.10.2026 — search split from the hint): `find` returns
the **full** result list; the coverage rule no longer filters it and only
flags each position.

| | |
|---|---|
| Input | `query: string` (required), `limit?: integer` (default 5, **max 10**), `restrict_to?: string[]` (skill-name / glob allowlist filter) |
| Answer | `{ok:true, items:[{name, path, score, why, confident}]}` sorted by descending `score`; `why` — one line, ≤160 chars; `confident: boolean` — the position covers ≥ `min(2, N)` significant query tokens (N = the number of the query's meaningful tokens), i.e. it would be eligible for the hint |
| Index fields | `name` (×3), `description` (×2), `headings` (×1), **`aliases` (×1)** — the v0.2 bilingual bridge: RU↔EN dictionary equivalents of the document's own terms, written at index time from the static `core/lexicon.ru-en.json` (local file only, no network/LLM, R5); the confidence rule (≥`min(2, N)` significant tokens by token equality) applies to alias matches like any other token, except the weak pairs listed in `core/lexicon.ru-en.json` under `_weak` — those rank but never count toward confidence (v0.2.1) |
| Limits | ≤10 items; ≤1 `why` line per item; other fields truncated |
| Empty query | `{ok:true, items:[], note:"пустой запрос"}` |
| No hits at all | `{ok:true, items:[], note:"ничего не найдено"}` |
| Hits, none confident | `{ok:true, items:[{…, confident:false}, …], note:"уверенных совпадений нет"}` — the list is still returned (v0.3) |
| Errors | `E_INVALID_INPUT` (not a string, `limit` outside 1–10 — rejected, not clamped), `E_UNAVAILABLE` (skill directory unavailable / index not built; the call fails, opencode still starts) |

**AC3 caveat (owner decision 26.10.2026).** The acceptance criterion AC3 —
«no random hints» — applies to the **hint** (`plugin/hint.mjs`, which builds
its block from `confident:true` positions only), **not** to the full `find`
output: `find` may legitimately return `confident:false` positions, and the
absence of confident ones is reported by `note`, not by an empty list.

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
  text part per request (≤2 positions, ≤1000 chars) and touches nothing else —
  messages, history, tools and options are unchanged; it never calls the
  `skill` tool, so it cannot create skill-gate events (R3, R4).
- **Fail-open** (R6): any internal error drops the hint instead of failing the
  request; `SKILL_ROUTER_HINT=off|0|false` removes the hint completely.

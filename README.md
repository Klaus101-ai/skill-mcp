# skill-router

Local skill search and ranking for [opencode](https://opencode.ai). Indexes
`SKILL.md` files (frontmatter `name`, `description`, body headings) and answers
queries with a ranked list of matching skills. Everything runs locally:
**no network, no LLM, no embeddings, no API keys, files are read-only.**

Status: **M1–M7 complete, the M9 attempt reverted, final acceptance sets
A / B / C measured, v0.3 split search from the hint.**

- **M1–M4**: core index and ranking (`core/`), CLI smoke run, baseline
  evaluation, the **MCP server** (`server/`, stdio: `find` / `outline` /
  `read-section`), the **context hint plugin** (`plugin/`, `<skill_hint>` block
  before model dispatch), and the held-out evaluation (**set A = validation**).
- **M5–M7**: the matching pipeline — normalization + light stemming, the AC3
  significant-match gate, token-level match semantics (dot/hyphen word rule,
  upper-case acronym whitelist), and finally the **coverage rule** over a
  **standard service-word stop list** (the score threshold was deleted).
- **M8**: acceptance **set B** measured as built — `AC2` and `AC3` fail there,
  numbers kept as measured (see Evaluation).
- **M9** (informative-token coverage and typo tolerance) was tried and
  **reverted** (`Revert M9`, `d1edd63`): it made recall worse, so HEAD runs
  the M7/M8 behaviour again.
- **v0.3** (owner decision 26.10.2026): **search and hint are split.**
  `search()` / the MCP `find` no longer filter the list with the coverage
  rule — they return everything the index found, each position flagged
  `confident`; the plugin hint is built from `confident:true` positions only.
  Recall is therefore measured on the **full** list (Evaluation updated), and
  AC3 «no random hints» binds the **hint** (measured by `measure/hint.mjs`),
  not the full `find` output — see **Search vs hint** and `docs/contract.md`.
- Final acceptance sets **A / B / C** are measured; the acceptance verdict is
  mixed — two of the eight acceptance criteria fail (`AC2` on B and C, `AC3`
  for the hint on B and C). See **Evaluation**, **Known limitations** and the
  reproduction commands in **Verification**.

This is an early release (**v0.1**) with the limitations listed below — read
them before relying on it.

## Requirements

- Node.js >= 20
- One runtime dependency: [`minisearch`](https://github.com/lucaong/minisearch) 7.2.0 (MIT, BM25+)

## Install

```sh
npm install
```

Connecting the product to opencode is an owner's action; the config is read
once at startup, so **restart opencode after every change below**.

### 1. MCP server

One entry in the `mcp` section of the config (`~/.config/opencode/opencode.json(c)`
or the project `opencode.json(c)`):

```jsonc
"mcp": {
  "skill-router": {
    "type": "local",
    "command": ["node", "E:\\1_Products\\skill-router\\server\\index.mjs"],
    "enabled": true
  }
}
```

### 2. Plugin

Add the absolute path of the plugin **directory** to the `plugins` array:

```jsonc
// ~/.config/opencode/opencode.json(c)  or  <project>/opencode.json(c)
"plugins": [
  "E:\\1_Products\\skill-router\\plugin"
]
```

opencode loads a directory's `index`/`server` module — here
`plugin/index.ts`, the same `{id, setup}` object as
`plugin/skill-router-hint.ts`, assembled from `./hint.mjs`. A path to a
single **file** in the `plugins` array is ignored: the loader drops it with
the warning `configured plugin path must be a directory`
(anomalyco/opencode#46551).

Alternatively copy it into `~/.config/opencode/plugins/` — **keeping the
repository layout**: the entry imports `./hint.mjs`, and `plugin/hint.mjs`
imports `../core/*`, so the copied `plugin/*` files must stay **next to a
`core/` directory** (from `~/.config/opencode/plugins/` the relative
`../core/*` resolves to `~/.config/opencode/core/`, so copy `core/` there as
well — `plugin/skill-router.config.json` rides along in the same folder). A
single copied `.ts` file will not work on its own. Auto-discovery loads every
`*.ts` in that folder, so copy **one** of `index.ts` / `skill-router-hint.ts`
— both hold the same `id`.

### 3. Restart opencode

The config (mcp + plugins) is loaded only at startup — restart to apply.

### 4. Environment variables

| Variable | Values | Effect |
|---|---|---|
| `SKILL_ROUTER_HINT` | `off`, `0`, `false` (case-insensitive) | turn the hint off entirely (default: enabled) |
| `SKILL_ROUTER_DEBUG` | `1` | diagnostics to **stderr**: index build, dropped hints with timing, fail-open reasons |

### 5. deny/allow config (`plugin/skill-router.config.json`)

```json
{
  "deny":  { "tenderwriter": ["contract-review*"] },
  "allow": { "some-agent": ["skill-a", "skill-b*"] }
}
```

The config file must be strict JSON — comments are not allowed; a malformed
file is ignored (fail-open). Use `SKILL_ROUTER_DEBUG=1` to see the warning.

By default everything is hintable except the agent's `deny` entries; an
`allow` list narrows it to those names (minus `deny`). Changes to this file
take effect after an opencode restart (config is read at startup); a missing
or malformed config falls back to the defaults (fail-open).

## Usage

```sh
npm test        # unit tests (node:test), including the spawned MCP server
npm run smoke   # build the index over the real skill roots, run 5 fixed queries
npm run measure # held-out metrics: product vs baseline recall@5 / NDCG@10 (measure/heldout.jsonl)
node measure/hint.mjs   # hint metrics: formed / hit@2 / junk on empty (sets A, B, C)
npm run latency # hint-formation latency p50/p95/max along the plugin path
npm run measure:baseline # standalone baseline BM25 recall@5 on the draft set
npm run server  # start the MCP server on stdio
node cli/plugin-demo.mjs   # print the exact <skill_hint> block the plugin adds (+ timing)
```

Programmatic API (`core/`):

```js
import { defaultRoots, discoverSkills, resolveSkillPath } from "./core/sources.mjs";
import { buildIndex, search, selectWinner } from "./core/index.mjs";

const { skills, skipped } = discoverSkills(defaultRoots());
const index = buildIndex(skills);
const hits = search(index, "bug bounty report", { limit: 5 });
// -> [{ name, path, score, why, confident }, ...]  (v0.3: the full list; `confident` marks the ≥min(2, N) coverage rule)
```

- Field weights: `name` x3, `description` x2, `headings` x1 (re-confirmed as
  the best of three candidates on set A in M5, `measure/weights.mjs`).
- Normalization + light stemming (`core/text.mjs`): lower-case, `ё`→`е`,
  punctuation stripped, frequent RU/EN endings cut with a 3-character root
  floor — one pipeline injected as MiniSearch `tokenize` + `processTerm`, so
  documents and queries are treated identically.
- **Word rule (M6)**: a word is letters/digits with an optional inner dot —
  `next.js` is ONE word (the query `next` does **not** match it), while a
  hyphen splits words: `gsap` matches `gsap-scrolltrigger`, and
  `AI-документ` yields the two tokens `AI` + `документ`.
- **Coverage rule → `confident` flag (M7 rule; v0.3 split)**: a position is
  **confident** when it **covers enough of the query's meaningful tokens** —
  at least `min(2, N)` of them, `N` = the number of meaningful query tokens.
  A token is meaningful when it is ≥3 chars or an **upper-case whitelisted
  acronym** (`AI`, `ML`, `UI`, `UX`, `QA`, `PR`, `HR`, `IT`, `CI`, `CD`,
  `DB`, `API`, `SDK`, `GPU`), and is **not** a service word from the standard
  stop list (English: `when what which who why how should would could can …`;
  Russian: `когда что какой как почему где чтобы если или но для при …` —
  full list in `core/text.mjs`; subject words such as *review, check, audit,
  policy, contract, договор, проверь, аудит, политика* are never stop words).
  The count uses **token equality** after stemming — never a substring of a
  longer word. **v0.3 (owner decision 26.10.2026): the rule no longer filters
  the list.** `search()` / `find` return everything the index found, each
  position carrying `confident: true|false`; the MCP `find` only attaches
  `note` («ничего не найдено» on an empty list, «уверенных совпадений нет»
  when every position is `confident:false`), and the plugin hint builds its
  block from `confident:true` positions only — no confident position means no
  block. See **Search vs hint** below.
  **Why two tokens:** a single shared word is not proof of the topic — that is
  exactly how junk queries used to get answers (one «office», one «when»);
  two matched tokens are the minimal sign that a skill really talks about the
  request. For a short query of 1–2 meaningful tokens one of them already
  counts (`min(2, N)`), so a precise one-word query stays confident; `N = 0`
  (service words only) can be proven by nothing at all and never reaches
  MiniSearch (`search()` answers `[]`). The rule is what keeps the **hint**
  quiet on junk — it is no longer what empties the **search** output.
  **No score threshold remains** (M7 deleted `MIN_STRENGTH` together with
  `corpusCeiling`): scores still *rank* the list, they no longer *validate*
  it, so nothing is derived from a measured gap on set A and no number has to
  be re-derived when the corpus changes. Historical effect of the M7 rule on
  set A (when it still gated the list): AC3 2/10 → 0/10 non-empty, hard
  recall@5 0.6000 → 0.7333, no query lost its answer
  ([`measure/README.md`](measure/README.md) § M7); v0.3 un-gates the search
  and re-measures — see **Evaluation**.
- Duplicate skill names (the same skill installed in several roots) collapse
  to the best-scoring entry; backup directories (`_backup`, `_backups`,
  `.backup`, `backup`) are never indexed.
- `why` is a single line, max 160 chars: matched fields plus up to 6
  significant terms (stop words and 1-character tokens are dropped; terms are
  shown in their stemmed form). Field attribution is token-level (M6): a
  field is credited only when it really contains an equal token — a substring
  does not count (`Officer` never proves `office`).
- `restrict_to: ["name-or-glob*"]` filters results to an allowlist of skill names.
- Empty / whitespace / punctuation-only queries — and queries with no
  meaningful token at all (service words only) — return `[]`. Every other
  query returns the full ranked list with `confident` per position; «no
  random hints» is upheld by the hint itself (v0.3), see **Search vs hint**.
- `skipped` lists `SKILL.md` symlinks whose real path escapes their root
  (`reason: "outside-root"`); `selectWinner` applies the shared
  "highest score, then lexicographically first path" rule.

## MCP server

`server/index.mjs` is a local **stdio** MCP server (JSON-RPC 2.0, one message
per line). `stdout` carries JSON-RPC messages only — every log line goes to
`stderr`; the process exits when stdin closes.

Protocol: initialization handshake for revisions **2025-11-25** and
**2025-06-18** (the client's requested version is echoed when supported,
otherwise the server answers with `2025-11-25`).

### Connect it in opencode

Add one entry to the `mcp` section of your config
(`~/.config/opencode/opencode.json` or the project `opencode.json(c)`):

```jsonc
"mcp": {
  "skill-router": {
    "type": "local",
    "command": ["node", "/path/to/skill-router/server/index.mjs"],
    "enabled": true
  }
}
```

Restart opencode afterwards — config is loaded once at startup.

### Calls

```jsonc
// -> {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"skill-router",...}}}
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0.0"}}}

// notification: no response
{"jsonrpc":"2.0","method":"notifications/initialized"}

// -> {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"find",...},{"name":"outline",...},{"name":"read-section",...}]}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}

// find (limit 1-10, default 5) — v0.3: the FULL list, `confident` per item
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find","arguments":{"query":"bug bounty report","limit":3}}}
// -> result.content[0].text = {"ok":true,"items":[{"name":"bugbounty","path":"...","score":116.1,"why":"matched name+description: bug, bounty","confident":true}]}
// empty query    -> {"ok":true,"items":[],"note":"пустой запрос"}
// no hits at all -> {"ok":true,"items":[],"note":"ничего не найдено"}
// hits, none confident -> {"ok":true,"items":[{...,"confident":false}],"note":"уверенных совпадений нет"}

// outline: name OR path
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"outline","arguments":{"name":"bugbounty"}}}
// -> {"ok":true,"name":"bugbounty","path":"...","description":"...","headings":[{"level":1,"text":"...","line":12}],"truncated":true?}

// read-section: heading text without '#' or its 1-based number
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read-section","arguments":{"name":"bugbounty","heading":"When to use this Skill","max_lines":150}}}
// -> {"ok":true,"name":"bugbounty","heading":"...","line_start":40,"lines":["..."],"truncated":false}
```

### Errors

- Tool-level (returned as text content with `isError: true`):
  `{"ok":false,"error":{"code":"E_INVALID_INPUT|E_NOT_FOUND|E_FORBIDDEN|E_SECTION_NOT_FOUND|E_UNAVAILABLE","message":"..."}}`.
  `limit > 10` and other out-of-range inputs are rejected, not clamped.
- Unknown tool → JSON-RPC `-32602`; unknown method → `-32601`; malformed line
  → `-32700`; invalid request → `-32600`; unexpected server failure → `-32603`.
- If no skill directory is available the first tool call returns
  `E_UNAVAILABLE`; the server keeps running and opencode still starts.
- The index is built lazily on the first tool call and cached for the
  lifetime of the process (no background reindexing).

## Plugin (context hint)

`plugin/index.ts` — the directory entry point opencode loads (the same
`{id, setup}` object is assembled in `plugin/skill-router-hint.ts`) — is an
opencode **context-hook plugin**: right before each model dispatch
(`context` hook — the agent loop, including tool-driven continuations) it
appends **one text part** to the request's `system` array with at most **2**
skill suggestions:

```text
<skill_hint source="skill-router" note="подсказка, не загрузка: скилл не открыт">
- supply-contract-review: <first line of its description>; открыть: инструмент skill, name=supply-contract-review
</skill_hint>
```

Messages, history, tools and options are never modified — only that one
`system` part is appended (and at most once per request).

**Only `confident:true` positions are hinted (v0.3).** The search behind the
block returns the full result list, and the hook drops every `confident:false`
position before it fills the two slots: a query whose matches do not cover
enough meaningful tokens gets **no block at all**, exactly as an empty result.
This is where AC3 («no random hints») lives — the MCP `find` deliberately
shows the whole list with the flag (see **Search vs hint**).

What it does **not** do, by contract:

- it **never loads skills**: no `skill` call, no other tool calls, no file
  writes, no events — so it cannot trigger or fake a `skill-gate` event;
- it does not replace the lead's mandatory «Скиллы» field, it is a hint text;
- no network, no LLM, no embeddings, no keys: BM25 search over the local index.

Budget and safety (fail-open): ≤2 entries, ≤1000 chars, ≤150 ms formation —
a hint that would exceed the time budget is dropped (reported with
`SKILL_ROUTER_DEBUG=1`), and any internal error is swallowed: the model request
continues without a hint instead of failing. The index is built **once per
opencode process** on the first hook call; that first call pays the build
(~400 ms (measured 370–414 ms) on a 367-skill install) and is normally dropped
by the 150 ms guard — the next dispatch hints normally.

### Files

| File | Role |
|---|---|
| `plugin/index.ts` | directory entry point loaded by opencode: `export default { id, setup }`, registers the `context` hook (thin — imports only `./hint.mjs`) |
| `plugin/skill-router-hint.ts` | the same plugin object as `index.ts`, kept as a standalone module (neither `.ts` imports the other `.ts`) |
| `plugin/hint.mjs` | hook logic (plain ESM — shared with tests and the demo, no build step) |
| `plugin/hint.d.mts` | local type declarations (the repo does **not** depend on `@opencode/plugin`) |
| `plugin/skill-router.config.json` | deny/allow config, resolved **next to the plugin module** (`plugin/`) |

Keep the repository layout: the entry (`plugin/index.ts`) imports
`./hint.mjs`, which imports `../core/*` — a single copied `.ts` file will not
work on its own.

### Connect it in opencode

Add one entry — the plugin **directory** — to the `plugins` array of your
config and restart opencode (config is loaded once at startup):

```jsonc
// ~/.config/opencode/opencode.json(c)  or  <project>/opencode.json(c)
"plugins": [
  "/absolute/path/to/skill-router/plugin"
]
```

The loader resolves the directory to its `index`/`server` module — here
`plugin/index.ts`. A path to a single file is ignored (`configured plugin
path must be a directory`).

Alternatively rely on plugin auto-discovery: opencode loads `*.ts`/`*.js` from
`.opencode/plugins/` (project; documented) and from `~/.config/opencode/plugins/`
(global directory; observed on a live install where `"plugins": []` still loads
`skill-gate.ts`). In the auto-discovery route place the whole `plugin/` +
`core/` pair, not just the entry file — and copy only **one** of `index.ts` /
`skill-router-hint.ts`: auto-discovery loads every `*.ts` file there, and the
two hold the same plugin `id`.

This repository never registers the plugin by itself — connecting it is one
explicit config line, an owner's action.

### Environment variables

| Variable | Values | Effect |
|---|---|---|
| `SKILL_ROUTER_HINT` | `off`, `0`, `false` (case-insensitive) | disable the hint entirely; default: enabled |
| `SKILL_ROUTER_DEBUG` | `1` | one-line diagnostics to **stderr**: index build, dropped hint with its timing, fail-open reasons |

### skill-router.config.json

```jsonc
{
  "deny":  { "tenderwriter": ["contract-review*"] }, // never hinted for this agent
  "allow": { "some-agent": ["skill-a", "skill-b*"] } // ONLY these are hinted for this agent
}
```

- default: every skill is hintable except the agent's `deny` entries;
- when an `allow` list exists for an agent, only it is hinted (still minus
  `deny`);
- keys are agent ids from the context event (`event.agent`), values are skill
  names with optional `*` patterns;
- a missing or malformed config falls back to the defaults (fail-open), it is
  never an error.

### Demo

```sh
node cli/plugin-demo.mjs ["query..."]   # default query: «проверь договор поставки»
```

Prints exactly the text part the plugin would append to `system` and the
formation time, without opencode running.

## Skill roots (read-only)

- `~/.config/opencode/skills`, `~/.config/opencode/skill`
- `~/.opencode/skills`
- `~/.claude/skills`, `~/.agents/skills`
- `<project>/.opencode/skills` (from the current working directory, if present)

`resolveSkillPath(skill, root)` refuses any path that resolves outside its root
(path-traversal guard).

## Bilingual search (RU ↔ EN, v0.2)

A large part of the skill corpus is described in English, so a Russian query
like «тесты» used to reach only the Russian-described skills. v0.2 adds a
**static term bridge**:

- **Dictionary**: [`core/lexicon.ru-en.json`](core/lexicon.ru-en.json) — a
  plain JSON file `{ "русский термин": ["english", "equivalents"] }`,
  **177 pairs** across the domains of the corpus (law/contracts, tenders,
  apps, sites, texts, data/privacy, development, security, HR, finance).
  Nothing else: no network, no LLM, no embeddings (R5) — the bridge is
  exactly this one file.
- **How it works**: at index time each skill's `name + description + headings`
  is scanned for dictionary terms. Every hit writes the *other-language*
  equivalents into a separate indexed field **`aliases`** (weight 1, after
  name ×3 / description ×2 / headings ×1). The symmetry is derived from the
  same file: a document containing `contract` gets `договор` in `aliases`, a
  document containing `договор` gets `contract` — so a Russian query finds an
  English-described skill and an English query finds a Russian-described one.
- **Same pipeline as everything else**: `aliases` is tokenized, normalized
  and stemmed by the same `core/text.mjs` functions as every other field, so
  «тесты» matches the alias `test` through stemming, and the coverage rule
  behind `confident` applies to alias matches like any other token — except
  the weak pairs below (v0.2.1).

**Weak pairs (v0.2.1).** Seven pairs are flagged in the `"_weak"` list of the
same file: `письмо↔letter`, `возврат↔return`, `подписка↔subscription`,
`дизайн↔design`, `форма↔form`, `лот↔lot`, `доверенность↔power`. Both sides of
these pairs are everyday words in unrelated skills (`letter` in cover-letter
and alphabet advice, `form` in form builders, `lot` in tenders, `power` in
anything "powerful"), so their aliases are *ambilateral*: they drag unrelated
skills into the ranking and — worse — satisfy the AC3 coverage rule by
themselves. Set B #51 was exactly that: `подписк` matched through
`subscription` plus an incidental `cloud`, two "proofs" for a junk query.
Semantics of a weak pair: **still indexed, still ranked** (the alias keeps
weight 1 and its BM25 contribution), but **never counted as one of the
`≥ min(2, N)` meaningful matches** — a weak alias alone can not prove a
topic; the skill's own text or a strong pair has to. The coverage vocabulary
of a document is its own name/description/headings tokens plus its STRONG
aliases only (the `cover` field, written at index time). Honest cost: a weak
pair can no longer be the sole language bridge — a Russian «письмо» alone
no longer reaches an English letter-writing skill; that query needs a second
shared token.

**How to extend**: add a line to `core/lexicon.ru-en.json`
`"русский": ["english"]` (one JSON key per term, values are non-empty string
arrays, keys must stay unique — `npm test` enforces all of this and the
150–250 pair range). A pair whose English side is an ordinary word in
unrelated skill texts also gets its RU key listed in `"_weak"` (the flag works
in both directions; the list is pinned to its seven current members by
`npm test` — add a member only when the ambiguity is demonstrated, e.g. it
creates a false coverage proof). Re-run `npm test` and `npm run measure`; no
code change is needed.

Measured effect on the fixed sets (26.10.2026): set A recall@5 stays
**0.7600**, AC3 stays **0/10**; «тесты» now returns 36 skills (27 with an
English description, 0 before), `contract` 43 (12 with an English description).
v0.2.1, same date: B AC3 **4/10 → 3/10** (#51 `saas-msa-review` cut), B
recall@5 **0.7600 → 0.7800** (B #40 turned into a hit), C NDCG@10 **0.5871 →
0.5921** and on C #46 `domain-dispute` is back at top-1 (the previously
top-ranked `dsar-response` lost its weak-alias coverage); set A unchanged.

## Search vs hint

Since **v0.3** (owner decision 26.10.2026 — *«разделить поиск и подсказку»*)
the two consumers of the index no longer share one gate:

| | MCP `find` / `search()` | plugin hint |
|---|---|---|
| what it returns | **the full ranked list** the index found | **at most 2 positions**, `confident:true` only |
| confidence | each item carries `confident: true\|false` (the `≥ min(2, N)` coverage rule) | `confident:false` positions are dropped before the two slots are filled |
| nothing confident | items still returned + `note: "уверенных совпадений нет"` | **no block** (same as an empty result) |
| nothing found | `items: []` + `note: "ничего не найдено"` (empty query: `note: "пустой запрос"`) | no block |
| AC3 «no random hints» | **not applicable** — a flag, not a filter | **binding** — this is where AC3 lives |

Why: one shared gate did two incompatible jobs. It made `find` lose short
precise queries (a real skill overlapping on one word was simply not there),
and it was the only thing standing between a junk request and the model's
context. Splitting them keeps both properties where they belong — the search
shows what exists (with the confidence flag), the hint stays silent unless a
skill actually **proves** the request.

- **Pool**: the hint searches with the same `limit: 10` candidate pool and
  then keeps only `confident:true` entries; budgets (≤2 positions, ≤1000
  chars, ≤150 ms), fail-open, R1–R4 and deny/allow are unchanged.
- **Measurement**: search metrics stay in `measure/run.mjs` (recall@5 / NDCG
  on the full list); the hint has its own harness `measure/hint.mjs`
  (formed-rate, top-2 hit-rate on easy/hard, junk-rate on `empty`, sets
  A/B/C, `--json`).
- **Measured effect of the split** (26.10.2026): the hint itself is
  **unchanged** — formed/hit/junk are identical before and after on all three
  sets (the rule feeding it is the same); what changed is the `find` output
  (now complete) and, with it, recall on the full list (table below).

## Evaluation

Full methodology, per-set tables and history: [`measure/README.md`](measure/README.md).
The product contract (R1–R6, hint block, tool contracts, safety guarantees):
[`docs/contract.md`](docs/contract.md).

Three fixed sets, each written independently before any run on it (60 queries
each, 365 skills in the index); numbers are **as measured** on 26.10.2026 after
**v0.3**, not rounded or adjusted:

| set | role | product recall@5 | baseline recall@5 | product NDCG@10 | baseline NDCG@10 | hint junk (`empty`, target 0/10) |
|---|---|---|---|---|---|---|
| A (`measure/heldout.jsonl`) | validation | 0.7200 | 0.7000 | 0.6305 | 0.6368 | 0/10 |
| B (`measure/heldout-b.jsonl`) | acceptance | 0.7800 | 0.8400 | 0.6541 | 0.6624 | 3/10 |
| C (`measure/heldout-c.jsonl`) | acceptance (final) | 0.7400 | 0.7600 | 0.5974 | 0.6654 | 1/10 |

**v0.3 before/after (same sets, same commands, 26.10.2026).** Recall@5 is now
computed on the **full** list (no gate), the AC3 column is the **hint's**
junk-rate from `measure/hint.mjs`:

| set | recall@5 before → after | NDCG@10 before → after | hint junk before → after |
|---|---|---|---|
| A | 0.7600 → **0.7200** | 0.6486 → **0.6305** | 0/10 → 0/10 |
| B | 0.7800 → **0.7800** | 0.6354 → **0.6541** | 3/10 → 3/10 |
| C | 0.7200 → **0.7400** | 0.5921 → **0.5974** | 1/10 → 1/10 |

Honest reading: the split **helped C** (0.7200 → 0.7400) and left B's recall
unchanged while its NDCG rose; on the validation set A the full-list recall
**fell** 0.7600 → 0.7200 (easy stayed 0.7714, hard 0.7333 → 0.6000) — with no
gate left to clear the top-5, non-confident high-scoring matches now occupy
slots that used to be cleaned before scoring. The expected «≥ baseline on at
least one of B/C» did **not** happen: B is 0.7800 vs 0.8400, C is 0.7400 vs
0.7600 — both still below baseline, as reported. The **hint did not move at
all**: formed/hit/junk are identical before and after on all three sets (the
rule feeding it is byte-for-byte the same one), which is exactly what the
split was for — `find` widened, the hint kept its behaviour.

Movement, honestly: pre-v0.2 the NDCGs were A 0.6375, B 0.6317, C 0.5915 and
recall@5 was A 0.7600 / B 0.7600 / C 0.7200. v0.2 (aliases field) re-ranked
ties: NDCG A → 0.6486, B → 0.6345, C → 0.5871, recall unchanged. v0.2.1
(weak pairs out of coverage) changed only what they had been faking: B
recall@5 0.7600 → **0.7800** and NDCG 0.6345 → **0.6354**, C NDCG 0.5871 →
**0.5921**, A and all three recalls otherwise unchanged; B's AC3 went **4/10
→ 3/10** (the v0.2 regression #51 `saas-msa-review` is gone), C's stays
1/10. v0.3 (search/hint split) re-measures recall on the **full** list — see
the before/after table above.

**Hint metrics (`node measure/hint.mjs`, 26.10.2026, identical before and
after v0.3):**

| set | easy formed | easy hit@2 | hard formed | hard hit@2 | junk on `empty` |
|---|---|---|---|---|---|
| A | 34/35 (97.1%) | 26/35 = 0.7429 | 15/15 (100%) | 9/15 = 0.6000 | **0/10** |
| B | 27/30 (90.0%) | 22/30 = 0.7333 | 20/20 (100%) | 14/20 = 0.7000 | **3/10** |
| C | 29/30 (96.7%) | 16/30 = 0.5333 | 20/20 (100%) | 17/20 = 0.8500 | **1/10** |

`formed` = a `<skill_hint>` block was appended for that query; `hit@2` = an
ethalon qrel sits inside the block's top-2 entries (the block holds ≤2
positions, so this is the hint's own recall figure — lower than recall@5 by
construction); `junk` = a block formed on an `empty` query (AC3 for the hint,
target 0/10).

Set C by kind (product vs baseline recall@5): **easy 0.6000 → 0.6333 vs
0.6667; hard 0.9000 vs 0.9000**.

What this means, plainly: the acceptance criterion **AC2** (product ≥ baseline
recall@5) still holds on the validation set A (0.7200 vs 0.7000) but **fails
on B and C**; **AC3** — since v0.3 an attribute of the **hint**, «no random
hints» — is 0/10 on A, **3/10 on B** (#53 `rag-kit`, #56 `copy-editing`, #57
`landing-page-copy`) and **1/10 on C** (#59 → `windows-powershell-ops`), all
three numbers identical to the pre-split run. The `find` output itself now
deliberately contains non-confident positions: on the 10 `empty` queries of
each set the top-5 holds a `confident:true` position in **0/10 (A), 2/10 (B),
1/10 (C)** — that is a property of the full list, not of the hint, and
`docs/contract.md` says so. One honest history note: right after v0.2 B briefly
measured 4/10 — #51 `saas-msa-review` passed the gate on the weak pair
`подписка↔subscription` plus an incidental `cloud`; v0.2.1 (weak pairs out of
coverage) removed it, and B recall@5 rose with it (see the table above). The
baseline is a fair reference: an independent
BM25 (k=1.2, b=0.7, smoothed IDF; document = name×2 + description + headings),
no MiniSearch, no stemming, no gate.

Set roles: **A = validation** (changes are judged by their before/after table
there; queries and qrels are frozen, the stop list was extended twice — the
standard service words in M7 and the owner-approved request verbs in v0.2
(32 forms)); **B and C = acceptance** (fresh held-out sets built by an independent agent, measured as built, never
tuned against).

## Known limitations

- **Lexical search, no semantics**: on the independent acceptance sets the
  product loses to plain BM25 (B 0.7800 vs 0.8400, C 0.7400 vs 0.7600 even
  after v0.3 ungated the list), and on the validation set A the full-list
  recall@5 **fell** 0.7600 → 0.7200 with the gate removed — non-confident
  matches now crowd the top-5. The coverage rule itself («2 significant
  words») still gates the **hint**, so a short precise query that overlaps a
  skill on a single word is **shown by `find` but not hinted**.
- **Residual false positives on everyday requests**: e.g. «Advise running
  shoes for rainy morning runs» → `windows-powershell-ops` (matched through
  «runn»/«run»), set C #59 — confident there, so the hint shows it: junk-rate
  on C stays 1/10 (B 3/10, target 0/10).
- **The bilingual bridge is only as good as its dictionary** (v0.2): a
  Russian query reaches an English-described skill only when the skill's text
  contains one of the 177 dictionary terms in `core/lexicon.ru-en.json`;
  terms outside the dictionary still do not cross languages. (No README
  limitation existed for this before v0.2 — the gap was found in diagnostics
  on 26.10.2026: «тесты» returned 7 results, 0 English-described; after v0.2
  it returns 36, 27 English-described.)
- **The first hook call after process start gets no hint**: the index is
  built lazily (~400 ms (measured 370–414 ms)) and the 150 ms guard drops
  that first block; the next dispatch hints normally.
- **Measured on one machine**, with sets A/B/C of 60 queries each over 365
  skills — small samples, single-machine latency.

## Verification

How to reproduce everything:

```sh
npm test                                    # unit tests (node:test), incl. the spawned MCP server
npm run smoke                               # index over the real skill roots, 5 fixed queries
npm run measure                             # set A (validation): product vs baseline recall@5 / NDCG@10
node measure/run.mjs --set measure/heldout-b.jsonl   # set B (acceptance)
node measure/run.mjs --set measure/heldout-c.jsonl   # set C (acceptance, final)
node measure/hint.mjs                       # hint metrics on A/B/C: formed / hit@2 / junk on empty (+ --json)
node measure/latency.mjs                    # hint-formation latency p50/p95/max + first-call build
node cli/plugin-demo.mjs                    # print the exact <skill_hint> block (+ timing)
```

## License

MIT — see [LICENSE](LICENSE).

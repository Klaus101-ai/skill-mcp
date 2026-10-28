# Changelog

All notable changes to skill-mcp (npm package: `skill-finder-mcp`).
Dates are the owner-decision / task dates recorded in the former README
changelog and `docs/contract.md`. Detailed metrics live in
[`measure/README.md`](../measure/README.md); the product contract (R1–R6,
tool contracts, safety guarantees) lives in [`contract.md`](contract.md).

## v0.6.4 — 2026-10-28

- **Find-first rule** (`<skill_router_rule>`, owner task 28.10.2026, phases 1a
  and «усилить правило»): an always-on instruction **unshifted to the front of
  `system`** — the model meets it before everything else. It requires calling
  the skill-mcp `find` as the **first action** of every task, before edits,
  checks and substantive answers. The rule insertion runs **before** the
  tool-silence check: the rule fires even under tool-silence and even when no
  `confident` candidate exists — «no auto-match» is not «no skills», the model
  must check by itself. Idempotent via the `<skill_router_rule>` marker.
  Off: `SKILL_MCP_RULE=off|0|false` or config `"rule": false` (env wins);
  `SKILL_MCP_HINT=off` disables the rule, the preload and the hint (the hook
  returns before the rule). Budget ≤500 chars — stated in a code comment
  (`plugin/hint.mjs`), there is no enforced constant.
- **Version alignment**: `package.json` / `package-lock.json` bumped
  0.6.1 → **0.6.4** (the README previously stopped at v0.6.3 labels while the
  code already carried v0.6.4).
- **README rewritten** for the public audience (13 sections, positioning
  «the agent has skills and ignores them»); the release history moved to this
  file, the internal evaluation lab (acceptance sets, AC2/AC3 discussion)
  stays out of the README.

## v0.6.3 — 2026-10-27 (owner task «Все 4 пункта», four fixes)

1. **Coverage gate**: `need = N <= 2 ? 1 : min(2, N)` — a 1–2-token query is
   proven by ONE matched token, so «Составь текст» now returns
   `confident:true` candidates and the hint builds a block; N ≥ 3 still needs
   two matched tokens; N = 0 (service words only) still returns `[]`.
2. **Pre-warm**: the index build is scheduled on `setImmediate` at plugin
   load, i.e. outside any user request — plugin load never blocks, the build
   fails open, and the **first hint costs a search only** (~1.5 ms on the test
   fixture; before, the first call paid the whole build, ~490–540 ms on a
   367-skill install, and was dropped by the 150 ms guard). Nothing is
   scheduled when `SKILL_MCP_HINT=off`.
3. **`find` visibility in the Code Mode catalog**: the catalog renders the
   cheapest listing line per namespace, and `outline` used to win (cost 76
   against `find`'s 115). `find`'s description now leads with a 77-char
   call-first line, the `inputSchema` property descriptions moved into the
   description, and `serverInfo.instructions` start with «Start with find» →
   line costs `find` 63 < `outline` 76 < `read-section` 113, so `find` is the
   rendered entry point (replica of the cost model in `test/server.test.mjs`).
4. **Preload instead of `@skill-id`**: a plugin `context` hook appends plain
   text only, and opencode v2 resolves `@skill` mentions solely as TUI-built
   structured parts — so an injected `@promo` would stay inert text. The
   **top `confident` candidate's `SKILL.md`** is now injected as opencode's
   own `<skill_content name="…">` system part **before** the hint part (body
   with the frontmatter stripped, `Base directory…`, up to 10 sibling files,
   capped at 20 000 chars with a truncation marker; one read-only file read +
   one directory listing inside the skill root). Switch:
   `SKILL_MCP_PRELOAD=off|0|false`. Hint budgets (≤5 / ≤1000 chars / ≤150 ms),
   the verbatim R1 note, tool names and skill ids are unchanged.

## v0.6.2 — 2026-10-27 (owner task)

- **Note reworded** (R1 wording, still verbatim in the block): «посмотри
  описания кандидатов; если один подходит — загрузи его через skill; если нет
  — не загружай.» — the earlier «кандидаты, не загрузка … выбери сам» read as
  permission not to load a matching skill.
- **`next` field**: every non-empty `find` answer carries a top-level `next` —
  `likely match: <name> — verify its description and load it` when the first
  item is `confident:true`, otherwise `review the candidate descriptions;
  load the matching skill`.

## v0.6.1 — 2026-10-27 (two owner tasks)

- **Q3 fix**: query expansion now also fires on the **verb stem «опиш»**
  (опиши/опишите/опишет/опишут), not only on the noun «описан…» — «опишите
  продукт» used not to expand, so promo fell out of the top-10 pool; with the
  fix «опишите продукт» puts **promo at position 1** again (regression tests:
  `test/candidates.test.mjs`). Search, ranking and the hint contract are
  otherwise unchanged.
- **Public package name**: the npm package is renamed to
  **`skill-finder-mcp`** (the bare `skill-mcp` is taken on npm; the former
  scope was a placeholder). The `skill-mcp` **bin is kept as a compatibility
  alias** — the MCP server name, the `mcp.skill-mcp` config key and the
  plugin id `skill-mcp-hint` are unchanged.

## v0.6.0 — 2026-10-26 (owner task, packaging + CLI)

- **npm package + one-command installer.** Package `skill-finder-mcp` with a
  `skill-mcp` bin; `scripts/build.mjs` (esbuild) produces **self-contained**
  `dist/` bundles — `plugin.mjs` (id `skill-mcp-hint`), `server.mjs`,
  `cli.mjs` — bundling `minisearch` + `jsonc-parser`; **no runtime
  dependencies** (`THIRD_PARTY_NOTICES.md`).
- **CLI** (`cli/main.mjs`): `init` (writes `mcp.skill-mcp` + the `plugins`
  directory entry, shows the diff, makes a `.bak-YYYYMMDD-HHMM` backup,
  preserves JSONC comments, idempotent, flags `--dry-run` / `--yes` /
  `--uninstall` / `--config`), `doctor` (node / config / mcp / plugin / roots
  / index + probe search / env / opencode checks, exit 0/1), `serve` (runs
  the stdio server). Install is `npx -y skill-finder-mcp init`.
- **deny/allow config moved** to `~/.config/opencode/skill-mcp.config.json`
  (`SKILL_MCP_CONFIG` overrides; the module-adjacent file became a fallback).
  Ranking, budgets and the R1–R6 contract are unchanged.

## v0.5.0

- **Env rename**: `SKILL_ROUTER_HINT` / `SKILL_ROUTER_DEBUG` →
  `SKILL_MCP_HINT` / `SKILL_MCP_DEBUG`. Legacy names are **deprecated**: they
  still work as a fallback when the new variable is not set, and the
  `SKILL_MCP_*` name wins when both are set.

## v0.4.1 — 2026-10-26 (owner decision, variant G of the variants lab)

- **In `search()`**: query expansion («описан…» appends «текст», «продукт…»
  appends « product»; tokens, `confident` and `why` run on the expanded
  query) and a **domain boost** — when the original query hits
  `BOOST_TRIGGER` (`описан|текст|лендинг|копирайт|продукт`), the capped pool
  is reordered so the **hardcoded `BOOST_ORDER`** list (promo, copywriting,
  site-copywriting, app-copywriting, documentation-and-adrs, redpolitika)
  leads it. The boost **reorders only, never adds**.
- **In the hint**: two silences before any block forms — **tool-silence** (a
  question about the plugin/router/MCP itself, «почему плагин не нашёл…», →
  no block) and the **confident gate** (no `confident:true` position in the
  top-10 pool → no block).
- **`find` default `limit` is now 10** (max 10).
- Measured on the fixed sets (26.10.2026): junk blocks on `empty` queries
  fall from 9/10, 10/10, 10/10 (v0.4) to **0/10 (A), 3/10 (B), 1/10 (C)**;
  hint hit@5 holds at 38/39/38; find@10 reads 43/44/42. Q1/Q3: promo at
  position 1; Q2: silent.

## v0.4 — 2026-10-26 (owner decision «5 кандидатов»)

- **The MCP stops claiming a single answer.** `find` and the plugin hint
  present **up to 5 candidates**, each with the skill's `description`;
  `confident:true` positions rank first and every unconfirmed candidate is
  marked **«(возможно)»**. AC3 is rephrased as **«кандидаты, не утверждение»**
  (candidates, not an assertion). The note is the v0.6.2 wording (see above).
  Ranking, weights and the bilingual lexicon are unchanged.
- R6 amendment: the position budget is **5** candidates instead of 2;
  ≤1000 chars and ≤150 ms are unchanged (an over-budget tail is dropped).

## v0.3.1 — 2026-10-26

- **Confident-first order**: `confident:true` positions always rank above
  `confident:false` ones (score desc, then name/path inside each group).
  Removed the intermediate post-split drop: validation-set recall@5 returned
  to 0.7600, B/C to 0.8400 / 0.7600 (equality with the baseline).

## v0.3 — 2026-10-26 (owner decision «разделить поиск и подсказку»)

- **Search and hint are split.** `search()` / the MCP `find` no longer filter
  the list with the coverage rule — they return everything the index found,
  each position flagged `confident`; the plugin hint is built from
  `confident:true` positions only (until v0.4). Recall is measured on the
  **full** list; AC3 binds the **hint**, not the `find` output.

## v0.2.1 — 2026-10-26

- **Weak pairs out of coverage**: seven dictionary pairs flagged `"_weak"`
  (`письмо↔letter`, `возврат↔return`, `подписка↔subscription`,
  `дизайн↔design`, `форма↔form`, `лот↔lot`, `доверенность↔power`) still rank
  (alias weight 1) but **never count toward the confident coverage** — a weak
  alias alone can no longer prove a topic. Measured: B AC3 4/10 → 3/10, B
  recall@5 0.7600 → 0.7800, C NDCG@10 0.5871 → 0.5921; set A unchanged.

## v0.2 — 2026-10-26

- **Bilingual bridge (RU ↔ EN)**: a static term dictionary
  [`core/lexicon.ru-en.json`](../core/lexicon.ru-en.json) — **177 pairs**;
  dictionary hits write the other-language equivalents into a separate
  indexed field **`aliases`** (weight 1, after name ×3 / description ×2 /
  headings ×1), symmetric and tokenized by the same pipeline. Measured:
  «тесты» went from 7 results (0 English-described) to 36 (27
  English-described); `contract` returns 43 (12 English-described). No
  network, no LLM — the bridge is exactly this one file.

## v0.1 — M1–M9 (the build lab, October 2026)

- **M1–M4**: core index and ranking (`core/`), CLI smoke run, baseline
  evaluation, the **MCP server** (`server/`, stdio: `find` / `outline` /
  `read-section`), the **context-hint plugin** (`plugin/`, `<skill_hint>`
  block before model dispatch), and the held-out evaluation (set A).
- **M5–M7**: the matching pipeline — normalization + light stemming, the
  token-level match semantics (dot/hyphen word rule, upper-case acronym
  whitelist), and the **coverage rule** over a standard service-word stop
  list; the score threshold was deleted (no `MIN_STRENGTH`, no
  `corpusCeiling`) — scores rank the list, they no longer validate it.
- **M8**: acceptance set B measured as built.
- **M9** (informative-token coverage and typo tolerance) was tried and
  **reverted** (`Revert M9`, `d1edd63`): it made recall worse, so HEAD runs
  the M7/M8 behaviour again.

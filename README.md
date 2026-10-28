# skill-mcp

> Your agent has skills — and still ignores them. skill-mcp finds the right
> SKILL.md, puts it in front of the model and preloads the likely match — the
> model still does the loading.

[![npm](https://img.shields.io/npm/v/skill-finder-mcp?label=npm)](https://www.npmjs.com/package/skill-finder-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)

A local [MCP](https://modelcontextprotocol.io) (Model Context Protocol,
modelcontextprotocol.io) server plus an [opencode](https://opencode.ai)
plugin: BM25 search over your `SKILL.md` files, up to 5 candidates in the
model's context, the likely match's SKILL.md preloaded, and a rule that makes
the agent call `find` before it starts working. No network, no LLM, no API keys.

Names, once: the npm package is **`skill-finder-mcp`** (the bare `skill-mcp`
is taken on npm), the MCP server and its bin are **`skill-mcp`**, the plugin
id is **`skill-mcp-hint`**. Current release: **v0.6.4**.

## Why

- opencode shows the model each skill's id, name and description. Whether the
  model ever opens one depends on the wording of the request: a skill whose
  description does not overlap the request is invisible to it.
- "No auto-match" reads as "no skills". When nothing matches, the agent
  proceeds with general knowledge and never asks whether a relevant skill
  exists somewhere in the folder.
- Hidden skills, kept out of the advertised catalog, never surface through
  normal listing at all.
- Manual loading requires the user to know the skill id and to type the load
  command at the right moment.
- Even when the model decides to look, discovery costs turns: `find`, then
  `outline`, then `read-section`, and the model has to remember to start.

Without skill-mcp, a request like "review the supply contract" goes straight
to a general answer:

```text
user: проверь договор поставки
agent: (answers from general knowledge; supply-contract-review sits in the skills folder, unopened)
```

With skill-mcp, the model's context carries candidates before the first
answer:

```text
<skill_hint source="skill-mcp" note="посмотри описания кандидатов; если один подходит — загрузи его через skill; если нет — не загружай.">
- supply-contract-review: Review of supply contracts against the playbook; открыть: инструмент skill, name=supply-contract-review
</skill_hint>
```

The agent reads the description, loads the skill, and the answer follows the
playbook.

## How it works

skill-mcp indexes the `SKILL.md` files it finds in the standard skill roots:
`name`, `description`, body headings, plus RU↔EN dictionary aliases. A query
runs BM25 over that in-memory index. Every hit carries a `confident` flag
(does the skill cover enough of the query's meaningful tokens?) and its
`description`, so the model judges candidates without extra calls. The model
stays the only brain: the product supplies candidates and calls no model
itself.

```text
skill roots: ~/.config/opencode/skills, ~/.opencode/skills, <project>/.opencode/skills, …
        │  read-only: name, description, headings from each SKILL.md
        ▼
in-memory BM25 index (name ×3, description ×2, headings ×1, aliases ×1)
        │  query → ranked candidates, each flagged confident yes/no
        ▼
three consumers, one index:
        ├─> MCP server: find / outline / read-section — top candidates for the model
        ├─> plugin preload: the top confident candidate's SKILL.md as <skill_content>
        └─> plugin hint: up to 5 candidates as a <skill_hint> system part
        │
find-first rule in front of the system prompt:
"call find as the first action of every task"
```

(Unconfirmed candidates in the hint are marked with «(возможно)» — see the
plugin section below.)

Three output layers share the index: the `find` tool for the model, the
preload and the hint inside every request, and the rule that tells the model
to start with `find`.

## Quick start

Requires Node.js ≥ 20.

```sh
npx -y skill-finder-mcp init
```

`init` finds your opencode config, adds the MCP server entry and the plugin,
shows the diff, and writes a `.bak-YYYYMMDD-HHMM` backup before touching
anything. It preserves JSONC comments and is safe to re-run. Then **restart
opencode**: config is read once at startup.

Give the agent a normal task ("проверь договор поставки" or "review my supply
contract"). The first request carries the find-first rule, so the agent calls
`find` before answering. You can print the `<skill_hint>` block without
opencode running:

```sh
node cli/plugin-demo.mjs "review my supply contract"
node cli/plugin-demo.mjs "проверь договор поставки"   # RU query — shows the bilingual bridge
```

Both demo commands run from a repository checkout (they call `cli/plugin-demo.mjs`
directly; after a global install you have `skill-finder-mcp` on the PATH).

To verify the install:

```sh
npx -y skill-finder-mcp doctor
```

`npx` fetches the package when it is not installed; after a global install
`skill-finder-mcp doctor` does the same. It exits 0 when healthy and names the
broken piece otherwise.

### Not for you if…

- you need semantic or embedding search — this is lexical BM25 over tokens;
- your skills live outside the roots listed under Configuration → Skill roots;
- your client is not opencode — the find-first rule, the preload and the hint
  are opencode plugin layers.

## What you get

| Component | Name | What it does |
|---|---|---|
| MCP server | `skill-mcp` | `find` / `outline` / `read-section` over the local index, exposed to the model as tools |
| Context-hint plugin | `skill-mcp-hint` | find-first rule, preload of the likely match, ≤5-candidate `<skill_hint>` block; system parts only |
| CLI | `skill-finder-mcp` (bin; `skill-mcp` alias) | `init` (one-command install), `doctor` (health check), `serve` (run the server by hand) |

## The MCP server

A local **stdio** server: JSON-RPC 2.0, one message per line. stdout carries
protocol only, every log line goes to stderr, and the process exits when
stdin closes. Handshake revisions `2025-11-25` and `2025-06-18`. The index
builds lazily on the first tool call and is cached for the life of the
process.

| Tool | Input | Output |
|---|---|---|
| `find` | `query` (required), `limit` 1–10 (default 10), `restrict_to` (skill-name globs) | `{ok, items:[{name, path, score, why, description, confident}], next}` — ranked candidates, confident first |
| `outline` | `name` or `path` | frontmatter plus headings (H1–H6) with line numbers (≤40 headings) |
| `read-section` | `name` + `heading` (text, or its number from `outline`), `max_lines` ≤600 (default 150) | the section's lines, from the heading to the next heading of the same level |

`confident: true` means a coverage-proven match (strong); `false` means
possible. Every item carries the skill's `description`, so one call is enough
to choose.

Example:

```jsonc
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find","arguments":{"query":"bug bounty report","limit":3}}}
// -> {"ok":true,"items":[{"name":"bugbounty","path":"…","score":116.1,
//       "why":"matched name+description: bug, bounty","description":"…","confident":true}],
//     "next":"likely match: bugbounty — verify its description and load it"}
```

Contract strings stay Russian. Translations:

- `note:"пустой запрос"` — "empty query";
- `note:"ничего не найдено"` — "nothing found";
- `note:"уверенных нет, вот возможные"` — "none confident; here are the
  possible ones".

**Errors.** Tool level: `{ok:false, error:{code, message}}`.

| Code | Meaning |
|---|---|
| `E_INVALID_INPUT` | out-of-range input; `limit > 10` is rejected, not clamped |
| `E_NOT_FOUND` | no such skill name or path in the index |
| `E_FORBIDDEN` | path outside the skill roots |
| `E_SECTION_NOT_FOUND` | heading not found in the skill |
| `E_UNAVAILABLE` | no skill root; the server stays up and opencode still starts |

Transport level (JSON-RPC):

| Code | Meaning |
|---|---|
| `-32602` | unknown tool |
| `-32601` | unknown method |
| `-32700` | malformed line |
| `-32600` | invalid request |
| `-32603` | unexpected failure |

**Code Mode.** opencode's Code Mode catalog renders each tool as one listing
line, and `find` is built to be the cheapest entry point: its description
leads with "Call this FIRST…". Inside `execute`, call it first:

```js
const r = await tools["skill-mcp"].find({ query: "review a commercial contract" })
```

## The context-hint plugin

The plugin registers a `context` hook: right before each model dispatch it
appends system parts, and nothing else. Messages, history, tools and options
are never modified. Three layers, in the order the model meets them:

| # | Layer | Injected | Budget and switch |
|---|---|---|---|
| 1 | find-first rule | `<skill_router_rule>`: a short instruction at the **front** of `system` requiring `find` as the first action of every task | ≤500 chars (the budget is stated in code comments, not enforced by a constant); off: `SKILL_MCP_RULE=off` or config `"rule": false` |
| 2 | preload | `<skill_content name="…">`: the top `confident` candidate's SKILL.md body, placed before the hint | ≤20 000 chars with a truncation marker; off: `SKILL_MCP_PRELOAD=off` |
| 3 | hint | `<skill_hint>`: up to **5** candidates with their descriptions, unconfirmed ones marked | ≤5 items, ≤1000 chars, ≤150 ms; off: `SKILL_MCP_HINT=off` (this switch removes all three layers) |

The rule (v0.6.4), verbatim. It fires even when the candidate hint stays
silent, because "no auto-match" is not "no skills":

```text
<skill_router_rule>
Первое действие в задаче — вызови find сервера skill-mcp с запросом из задачи. До этого не начинай правки, проверки и содержательные ответы. Если кандидат подходит — загрузи его через skill; скрытые из каталога скиллы тоже доступны через find. Нет блока <skill_hint> — значит «автосовпадения нет», а не «скиллов нет»: проверь сам. Пропуск = задача не выполнена.
</skill_router_rule>
```

English in one line: *call the skill-mcp `find` tool first, before edits,
checks or substantive answers; a missing `<skill_hint>` block means "no
auto-match", not "no skills"; skipping this means the task is not done.*

The hint block. The wrapper and the note are contract strings (R1) and never
claim that a skill is loaded:

```text
<skill_hint source="skill-mcp" note="посмотри описания кандидатов; если один подходит — загрузи его через skill; если нет — не загружай.">
- supply-contract-review: Review of supply contracts; открыть: инструмент skill, name=supply-contract-review
- supply-contract-templates (возможно): Templates for supply contracts; открыть: инструмент skill, name=supply-contract-templates
</skill_hint>
```

The note reads: "read the candidate descriptions; if one fits, load it with
the `skill` tool; if none fits, load nothing." «(возможно)» ("possibly")
marks a candidate the coverage rule did not prove. **Candidates, not a
claim:** the block presents options and the model chooses; the plugin never
asserts which skill is the right one.

Two silences run before a block forms. Both leave the rule untouched:

- **tool-silence**: a question about the plugin or the server itself
  ("почему плагин не нашёл…") gets no candidates; the model should answer the
  user;
- **confident gate**: no `confident: true` in the candidate pool means no
  block. Unconfirmed candidates appear only behind a proven one.

Ordering and cost control:

- The rule sits at the front of `system`, the preload follows, the hint is
  last; the note therefore never contradicts what is already in the context.
- Every part is idempotent (at most once per request) and **fail-open**: an
  internal error drops the part instead of failing the request.
- The index is **pre-warmed** at plugin load (`setImmediate`, outside any
  user request), so the first hint pays only the search (~1.5 ms on the test
  fixture), not the build.
- Demo without opencode (from a repository checkout): `node cli/plugin-demo.mjs
  ["query..."]` prints the exact `<skill_hint>` block and its formation time.

## Configuration

### Environment variables

| Variable | Values | Effect |
|---|---|---|
| `SKILL_MCP_HINT` | `off`, `0`, `false` (case-insensitive) | disable the rule, the preload and the hint (default: enabled) |
| `SKILL_MCP_PRELOAD` | `off`, `0`, `false` | disable the preload only; the hint keeps working |
| `SKILL_MCP_RULE` | `off`, `0`, `false` | disable the find-first rule only; config `"rule": false` does the same, and the env wins when both are set |
| `SKILL_MCP_DEBUG` | `1` | one-line diagnostics to **stderr**: index build, dropped hints with timing, fail-open reasons |
| `SKILL_MCP_CONFIG` | a file path | override the deny/allow config location |

Legacy names `SKILL_ROUTER_HINT` / `SKILL_ROUTER_DEBUG` (deprecated since
v0.5.0) still work as fallbacks when the new name is unset; `SKILL_MCP_*`
wins when both are set.

### deny/allow — `~/.config/opencode/skill-mcp.config.json`

```json
{
  "deny":  { "tenderwriter": ["contract-review*"] },
  "allow": { "some-agent": ["skill-a", "skill-b*"] }
}
```

Keys are agent ids; values are skill names with optional `*` globs. By
default every skill is hintable except the agent's `deny` entries; an `allow`
list narrows that agent to those names (minus `deny`). The file must be
strict JSON, comments are not allowed; a missing or malformed file falls
back to the defaults (fail-open, never an error). Resolution order:
`SKILL_MCP_CONFIG` → `~/.config/opencode/skill-mcp.config.json` (the
default) → a `skill-mcp.config.json` next to the plugin module (a repo
convenience) → in-code defaults. Changes apply after an opencode restart.

### Skill roots (read-only)

- `~/.config/opencode/skills`, `~/.config/opencode/skill`
- `~/.opencode/skills`
- `~/.claude/skills`, `~/.agents/skills`
- `<project>/.opencode/skills` (from the current working directory, if
  present)

Every path is resolved to its real path and must stay inside one of these
roots.

### Manual install

`init` is the supported route; the manual equivalent:

```jsonc
// ~/.config/opencode/opencode.json(c)  or  <project>/opencode.json(c)
"mcp": {
  "skill-mcp": { "type": "local", "command": ["node", "<abs>/dist/server.mjs"], "enabled": true }
},
"plugins": [
  "<abs>/dist/plugin"   // a DIRECTORY — a single-file path is dropped by the loader
]
```

Then restart opencode. From a tarball instead of the registry:

```sh
npm pack
npm install -g ./skill-finder-mcp-<version>.tgz
skill-finder-mcp init
```

### Uninstall and upgrade

To remove the product, drop both entries — the `mcp.skill-mcp` server and the
`plugins` entry — and restart opencode:

```sh
npx -y skill-finder-mcp init --uninstall
```

To upgrade, update the package (`npm install -g skill-finder-mcp@latest`, or
let a `npx -y skill-finder-mcp …` command fetch the newest version) and
restart opencode: config is read once at startup.

## Known limitations

- **Lexical search, no semantics.** BM25 over normalized, lightly stemmed
  tokens; a query phrased differently from the skill's description can miss
  it. The RU↔EN bridge is a dictionary, not a translation model.
- **False positives are marked, not eliminated.** An unconfirmed candidate
  carries «(возможно)»; a confident but irrelevant hit can still reach the
  model unmarked, and the model is expected to judge it against the
  candidate's description.
- **The preload costs context.** The likely match's SKILL.md body is added on
  every dispatch that forms a confident hint: up to 20 000 chars (roughly 5k
  tokens in the worst case, typically a few hundred).
  `SKILL_MCP_PRELOAD=off` removes it and leaves the hint alone.
- **The domain boost uses a hardcoded list.** Six skill names (`BOOST_ORDER`
  in `core/index.mjs`) are reordered to the front on domain queries; new
  domain skills are added to that list by hand. The boost reorders the pool
  the search already produced and never adds candidates.
- **The bilingual bridge is the dictionary.** A term outside the 177-pair
  `core/lexicon.ru-en.json` does not cross languages.
- **Measured on one machine** (a 365-skill corpus, 60-query batches, three
  runs): treat the latency numbers as a single-machine reference.

## Troubleshooting

Run the doctor first:

```sh
npx -y skill-finder-mcp doctor
```

It checks Node ≥ 20; your config path and that it parses; the
`mcp.skill-mcp` entry and that the server file exists; the plugins entry and
that the directory has an `index.mjs`; the skill roots, how many `SKILL.md`
files they hold, and a probe search; the plugin config path and the
`SKILL_MCP_*` variables; `opencode --version` (informational). Exit 0 means
healthy; any ✖ line makes it exit 1.

| Symptom | Fix |
|---|---|
| Nothing changes after editing config or env | opencode reads config once at startup: restart it |
| Warning `configured plugin path must be a directory` | the `plugins` entry points at a file; point it at the plugin directory (`dist/plugin`) |
| `E_UNAVAILABLE` from `find` | no skill root was found; check the roots list above. The server stays up and opencode still starts |
| Hint behavior is opaque | set `SKILL_MCP_DEBUG=1` and read the stderr lines: index build, dropped hints with timing, fail-open reasons |
| The agent does not call `find` | confirm the rule layer is on (`SKILL_MCP_RULE` unset, config `"rule"` not `false`) and the plugin loads (`doctor`, then restart) |

## Security & privacy

By contract ([docs/contract.md](docs/contract.md), R5):

- **No network, no LLM, no API keys, no telemetry.** The server speaks stdio;
  the plugin runs BM25 over a local index; nothing calls out.
- **Read-only.** Skill files are opened for reading, the index lives in
  memory; the product never writes, moves or deletes a file.
- **Root boundary.** Every path resolves to its canonical real path inside a
  skill root; anything outside is refused with `E_FORBIDDEN`. Symlink escapes
  are reported and skipped.
- **No side effects in opencode.** The plugin appends system text only and
  never calls the `skill` tool, so it cannot create or fake skill-gate events
  (R3, R4).
- **Fail-open** (R6): a broken hint drops the hint, never the request.

Third-party components are bundled at build time:
[minisearch](https://github.com/lucaong/minisearch) (MIT) and
[jsonc-parser](https://github.com/microsoft/node-jsonc-parser) (MIT);
`esbuild` is a devDependency and does not ship. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development & verification

```sh
npm run build   # esbuild → self-contained dist/ bundles (also runs on prepack)
npm test        # unit tests (node:test), including the spawned MCP server and the CLI
npm run smoke   # build the index over the real skill roots, run five fixed queries
npm run measure # held-out metrics over the fixed query batches (see measure/README.md)
npm run latency # hint-formation latency p50/p95/max along the plugin path
```

Programmatic API (`core/`, no build needed):

```js
import { defaultRoots, discoverSkills } from "./core/sources.mjs";
import { buildIndex, search } from "./core/index.mjs";

const { skills } = discoverSkills(defaultRoots());
const index = buildIndex(skills);
const hits = search(index, "bug bounty report", { limit: 5 });
// -> [{ name, path, score, why, description, confident }, ...]
```

The product contract (hint rules R1–R6, tool contracts, safety guarantees)
lives in [docs/contract.md](docs/contract.md).

## License

MIT — see [LICENSE](LICENSE). Bundled third-party licenses:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Version history: [docs/CHANGELOG.md](docs/CHANGELOG.md).

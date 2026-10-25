# skill-router

Local skill search and ranking for [opencode](https://opencode.ai). Indexes
`SKILL.md` files (frontmatter `name`, `description`, body headings) and answers
queries with a ranked list of matching skills. Everything runs locally:
**no network, no LLM, no embeddings, no API keys, files are read-only.**

Status: **M1 + M2 + M3 + M4 + M5 + M6** — core index, CLI smoke run, baseline
evaluation, the **MCP server** (`server/`, stdio: `find` / `outline` /
`read-section`), the **context hint plugin** (`plugin/`, `<skill_hint>` block
before model dispatch), the held-out evaluation (**set A = validation**), the
**M5 pipeline** (normalization + light stemming, the AC3 significant-match gate
and the relative noise floor) and the **M6 match semantics**: token-level
equality instead of substrings, the dot/hyphen word rule and the upper-case
acronym whitelist.

## Requirements

- Node.js >= 20
- One runtime dependency: [`minisearch`](https://github.com/lucaong/minisearch) 7.2.0 (MIT, BM25+)

## Install

```sh
npm install
```

## Usage

```sh
npm test        # unit tests (node:test), including the spawned MCP server
npm run smoke   # build the index over the real skill roots, run 5 fixed queries
npm run measure # held-out metrics: product vs baseline recall@5 / NDCG@10 (measure/heldout.jsonl)
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
// -> [{ name, path, score, why }, ...]
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
- **AC3 significant-match gate**: a result is valid only if at least one
  meaningful query token — ≥3 chars, or an **upper-case whitelisted
  acronym** (`AI`, `ML`, `UI`, `UX`, `QA`, `PR`, `HR`, `IT`, `CI`, `CD`,
  `DB`, `API`, `SDK`, `GPU`), not in the frozen ru+en stop list — is **equal**
  to a token of the skill's `name`+`description`+`headings` (never a
  substring of a longer word); otherwise `search()` returns `[]` — the MCP
  `find` answers `note: "ничего не найдено"` and the plugin simply shows no
  block. A relative noise floor then rejects weak leftovers whose best score
  is under 70% of the corpus ceiling for that query (re-derived after M6 with
  the measured gap: [`measure/README.md`](measure/README.md) § M6 § Threshold).
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
  meaningful token that any skill text matches — return `[]`: no random hints.
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

// find (limit 1-10, default 5)
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find","arguments":{"query":"bug bounty report","limit":3}}}
// -> result.content[0].text = {"ok":true,"items":[{"name":"bugbounty","path":"...","score":116.1,"why":"matched name+description: bug, bounty"}]}
// empty query -> {"ok":true,"items":[],"note":"пустой запрос"}
// no hits     -> {"ok":true,"items":[],"note":"ничего не найдено"}

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

`plugin/skill-router-hint.ts` is an opencode **context-hook plugin**: right
before each model dispatch (`context` hook — the agent loop, including
tool-driven continuations) it appends **one text part** to the request's
`system` array with at most **2** skill suggestions:

```text
<skill_hint source="skill-router" note="подсказка, не загрузка: скилл не открыт">
- supply-contract-review: <first line of its description>; открыть: инструмент skill, name=supply-contract-review
</skill_hint>
```

Messages, history, tools and options are never modified — only that one
`system` part is appended (and at most once per request).

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
(~330 ms on a 367-skill install) and is normally dropped by the 150 ms guard —
the next dispatch hints normally.

### Files

| File | Role |
|---|---|
| `plugin/skill-router-hint.ts` | loadable entry: `export default { id, setup }`, registers the `context` hook |
| `plugin/hint.mjs` | hook logic (plain ESM — shared with tests and the demo, no build step) |
| `plugin/hint.d.mts` | local type declarations (the repo does **not** depend on `@opencode/plugin`) |
| `plugin/skill-router.config.json` | deny/allow config, resolved **next to the plugin module** (`plugin/`) |

Keep the repository layout: the entry imports `./hint.mjs`, which imports
`../core/*` — a single copied `.ts` file will not work on its own.

### Connect it in opencode

Add one entry to the `plugins` array of your config and restart opencode
(config is loaded once at startup):

```jsonc
// ~/.config/opencode/opencode.json(c)  or  <project>/opencode.json(c)
"plugins": [
  "/absolute/path/to/skill-router/plugin/skill-router-hint.ts"
]
```

Alternatively rely on plugin auto-discovery: opencode loads `*.ts`/`*.js` from
`.opencode/plugins/` (project; documented) and from `~/.config/opencode/plugins/`
(global directory; observed on a live install where `"plugins": []` still loads
`skill-gate.ts`). In the auto-discovery route place the whole `plugin/` +
`core/` pair, not just the entry file.

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

## Evaluation

See [`measure/README.md`](measure/README.md). Two roles, fixed in M5:

- **set A** (`measure/heldout.jsonl`, commit `bbf9c74`) — independent, written
  by a different agent before any run; its M4 numbers are frozen, so from M5 it
  is the **validation set**: changes are verified here with a before/after
  table. Queries, qrels and stop words never change; weights and the threshold
  are chosen only through a measured comparison whose numbers are recorded in
  `measure/README.md`.
- **set B** — the honest **acceptance** set: a fresh held-out set to be built
  later by an independent agent that has not seen these numbers.

## License

MIT — see [LICENSE](LICENSE).

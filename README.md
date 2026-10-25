# skill-router

Local skill search and ranking for [opencode](https://opencode.ai). Indexes
`SKILL.md` files (frontmatter `name`, `description`, body headings) and answers
queries with a ranked list of matching skills. Everything runs locally:
**no network, no LLM, no embeddings, no API keys, files are read-only.**

Status: **M1 + M2** — core index, CLI smoke run, baseline evaluation and the
**MCP server** (`server/`, stdio: `find` / `outline` / `read-section`). The
plugin is not implemented yet.

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
npm run measure # baseline BM25 recall@5 on the draft query set
npm run server  # start the MCP server on stdio
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

- Field weights: `name` x3, `description` x2, `headings` x1.
- Duplicate skill names (the same skill installed in several roots) collapse
  to the best-scoring entry; backup directories (`_backup`, `_backups`,
  `.backup`, `backup`) are never indexed.
- `why` is a single line, max 160 chars: matched fields plus up to 6
  significant terms (stop words and 1-character tokens are dropped).
- `restrict_to: ["name-or-glob*"]` filters results to an allowlist of skill names.
- Empty / whitespace / punctuation-only queries return `[]` — no random hints.
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

## Skill roots (read-only)

- `~/.config/opencode/skills`, `~/.config/opencode/skill`
- `~/.opencode/skills`
- `~/.claude/skills`, `~/.agents/skills`
- `<project>/.opencode/skills` (from the current working directory, if present)

`resolveSkillPath(skill, root)` refuses any path that resolves outside its root
(path-traversal guard).

## Evaluation

See [`measure/README.md`](measure/README.md). The query set is a **draft**; the
final held-out set is produced separately (stage M4) and is never used for
tuning.

## License

MIT — see [LICENSE](LICENSE).

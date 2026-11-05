# skill-mcp

A local MCP server and opencode plugin that puts candidate `SKILL.md` files and the likely match in front of the model before it answers.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node: 20 or newer](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)

skill-mcp indexes the `SKILL.md` files already on your machine, searches them when a message arrives, and adds candidates plus the likely match to the request context. Everything runs locally: no network calls, no API keys, no model of its own.

Three names appear in this document. The package is `skill-finder-mcp` (`package.json`). The MCP server and its CLI bin are `skill-mcp` (`package.json`). The plugin id is `skill-mcp-hint` (`plugin/index.ts`).

## Why this exists

opencode shows the model only the id, name and description of each skill. A skill whose description does not overlap the request stays invisible, and a message with no auto-match reads as if no skills exist, so the agent answers from general knowledge instead of opening the skill that fits.

## Install

Requires Node.js 20 or newer (`package.json`).

Install from a checkout:

```sh
git clone https://github.com/Klaus101-ai/skill-mcp.git
cd skill-mcp
npm install
npm pack
npm install -g ./skill-finder-mcp-<version>.tgz
skill-finder-mcp init
```

`npm pack` runs the build first through the `prepack` script, then names the tarball after the package and its version. The package is not published to the npm registry, so the tarball is built on your machine. Use the version from `package.json` in the file name.

`init` finds your opencode config (`~/.config/opencode/opencode.jsonc`, else `.json`), writes `mcp.skill-mcp` as a local stdio server running `dist/server.mjs`, appends `dist/plugin` to `plugins`, prints the diff and saves a `.bak-YYYYMMDD-HHMM` copy before writing (`cli/main.mjs`). JSONC comments survive the edit, and a second run changes nothing.

| Option | Effect |
| --- | --- |
| `--config <path>` | edit this config file instead of the global one |
| `--dry-run` | print the diff, write nothing |
| `--yes` | apply without the interactive prompt |
| `--uninstall` | remove the `mcp` entry and the plugin entry |

Without a terminal, `init` needs `--yes`. Restart opencode afterwards: config is read once at startup.

## Quick start

```sh
skill-finder-mcp doctor
```

`doctor` checks Node, the config file, the MCP entry and the server file it points at, the plugin entry and the `index.mjs` inside the plugin directory, the skill roots, and a probe search. It also reports the plugin config path, the `SKILL_MCP_*` variables it sees and the `opencode` version on `PATH`. Exit code 0 means every check passed (`cli/main.mjs`).

Send a normal task in opencode, for example `review my supply contract`. The first request carries the router rule, so the agent calls `find` before it starts working. Candidates, and the likely match when one exists, arrive with that same request.

## Example

A `find` call over stdio, as the agent makes it:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find","arguments":{"query":"review a supply contract","limit":3}}}
```

The answer, with placeholder skills:

```json
{
  "ok": true,
  "items": [
    {
      "name": "supply-contract-review",
      "path": ".../skills/supply-contract-review/SKILL.md",
      "score": 31.42,
      "why": "matched name+description: contract, review",
      "description": "Checks a supply contract against the playbook: payment terms, penalties, delivery.",
      "confident": true
    }
  ]
}
```

Every item carries `confident` and the skill `description`, so the model can judge the list without another call. A top-level `next` tells it what to do with the result: load the likely match, or compare the descriptions before loading. `why` names the fields that matched and the terms that hit them.

## Configuration

### Environment variables

An unset variable keeps the default. `off`, `0` and `false` turn a layer off, case-insensitive.

| Variable | Default | Effect |
| --- | --- | --- |
| `SKILL_MCP_HINT` | on | off turns off the hint, the preload and the router rule |
| `SKILL_MCP_PRELOAD` | on | off drops the preloaded `SKILL.md`, keeps the hint |
| `SKILL_MCP_RULE` | on | off drops the router rule text only |
| `SKILL_MCP_GATE` | on | off disables the find gate |
| `SKILL_MCP_GATE_DEBUG` | off | `1` or `true` writes one line per gate decision to `~/.config/opencode/logs/skill-mcp-gate.log` |
| `SKILL_MCP_DEBUG` | off | `1` writes plugin and server diagnostics to stderr |
| `SKILL_MCP_CONFIG` | user config path | path to the plugin config file |

`SKILL_MCP_RULE` and `SKILL_MCP_GATE` accept an environment value that wins over the config file. `SKILL_ROUTER_HINT` and `SKILL_ROUTER_DEBUG` still work as fallbacks when the new names are unset.

### Config file

The plugin reads `~/.config/opencode/skill-mcp.config.json` unless `SKILL_MCP_CONFIG` or an explicit path says otherwise:

```json
{
  "rule": true,
  "gate": true,
  "deny": { "build": ["experimental-*"] },
  "allow": { "reviewer": ["*review*"] }
}
```

`rule` and `gate` are booleans. `deny` and `allow` are maps keyed by agent id; each value lists skill names or `*` glob patterns. Deny wins over allow, and an agent with an allow list sees nothing else. A missing, unreadable or malformed file falls back to the defaults, so a config mistake never breaks a session.

### Skill roots

The walker reads these directories, and only when they exist:

- `~/.config/opencode/skills`
- `~/.config/opencode/skill`
- `~/.opencode/skills`
- `~/.claude/skills`
- `~/.agents/skills`
- `<project>/.opencode/skills`

It skips `node_modules`, `.git` and backup directories; the match is on a whole directory name. Skill files are opened read-only, and a resolved path that escapes its root is refused with `E_FORBIDDEN`.

## MCP server tools

| Tool | Arguments | Limits |
| --- | --- | --- |
| `find` | `query` (required), `limit`, `restrict_to` | `limit` 1 to 10, default 10; `restrict_to` takes names or globs |
| `outline` | `name`, or `path` to a `SKILL.md` | frontmatter plus headings with line numbers, 40 headings max, then `truncated: true` |
| `read-section` | `name`, `heading`, `max_lines` | `heading` is text or its 1-based number; `max_lines` 1 to 600, default 150 |

`read-section` returns the heading line through the next heading of the same level.

The server speaks JSON-RPC 2.0 on stdio, one message per line, and exits when stdin closes. Every tool schema declares `additionalProperties: false`, and arguments are type-checked before a search runs. Failures come back either as a JSON-RPC code (-32700 through -32603) or as a tool error: `E_INVALID_INPUT`, `E_NOT_FOUND`, `E_FORBIDDEN`, `E_SECTION_NOT_FOUND`, `E_UNAVAILABLE`. The index is built on first use and cached for the life of the process.

Scoring is BM25 over the skill name, description, headings and bilingual aliases. There is no score cutoff: every hit comes back ranked, and `confident` marks the positions that cover enough significant query tokens.

## Plugin layers

The plugin adds three things to a request, all from the same index.

- `rule`: a fixed instruction block unshifted to the front of the system prompt on every owner message. It tells the agent to call `find` first and states that a missing hint block means no auto-match, not an empty skill folder. The rule fires even when nothing matched, and a marker keeps it to one copy per request.
- `preload`: the body of the top confident candidate, up to 20000 characters, as a `<skill_content>` part.
- `hint`: up to 5 candidates as a `<skill_hint>` part, 1000 characters max, built inside a 150 ms budget. Candidates without confidence are marked in the block.

The index warms up when the plugin loads, so the first request pays for a search rather than a full walk. A query that matches no skill produces no hint and no preload; the rule still goes in.

## Find gate

Until a `find` call is seen for the current owner message, the main session gets every other tool call refused. The refusal starts with `skill-mcp gate` and names the call to make.

These calls pass without `find`:

- `sequential_thinking`, `todowrite`, `todoread`, `question`, `skill`, `subagent` and `task`;
- `execute` whose code calls `find`;
- `execute` whose code calls `sequential_thinking` and nothing else;
- every call in a subagent session, which is outside the gate.

A new owner message is recognised by the number of user messages plus the text of the last one; a new signature closes the gate again. Unreadable session state or an `execute` payload the gate cannot read allows the call instead of refusing it. A missing or malformed config file does not: it leaves the gate on, which is the default. `SKILL_MCP_GATE=off` or `"gate": false` removes the layer.

The gate sees tool calls only. A reply written without tools is not intercepted, and the rule text is the only thing asking for a search there.

## Isolation

The plugin exports a plain object with `id` and `setup`. `@opencode/plugin` is imported dynamically inside a `.catch`, kept external in the build and declared as an optional peer dependency, so the bundle loads with or without it. Each hook registration sits in its own `try`/`catch`, and `setup` itself cannot throw: a broken hook degrades that hook, it never takes the session down. Diagnostics stay off unless `SKILL_MCP_DEBUG=1`. `test/plugin-shape.test.mjs` holds the export shape and the no-throw promise.

## Limitations

- Search is lexical. A request that shares no token with the name, description or headings of a skill will not find it.
- The RU to EN bridge is a fixed dictionary in `core/lexicon.ru-en.json`. Words outside it get no translation help.
- Candidate quality follows your frontmatter descriptions. A one-line description produces a thin hint.
- The gate covers tool calls only; see the note at the end of the find gate section.
- Latency figures in `measure/README.md` come from one machine and a 365-skill corpus. Treat them as a reference, not a promise.
- There is no CI workflow in the repository. Tests run where you run them.

## Troubleshooting

Start with `skill-finder-mcp doctor`; it reports each piece separately and exits non-zero on a problem.

A refusal that keeps coming back is a gate question, not a search question. Set `SKILL_MCP_GATE_DEBUG=1` and read one line per decision in `~/.config/opencode/logs/skill-mcp-gate.log`. The file is created only while the switch is on.

No hint block in a request usually means no confident candidate for that message, or `SKILL_MCP_HINT=off` in the environment of the process that runs opencode. `SKILL_MCP_DEBUG=1` prints what the plugin decided to stderr.

## Development

```sh
npm install
npm run build
npm test
```

`npm test` runs `node --test` over `test/`. The suite spawns the server, drives the CLI as a child process, and covers the gate, isolation, the bilingual bridge, packaging and the router rule. `npm run smoke` runs the smoke script, `npm run measure` and `npm run latency` regenerate the numbers in `measure/README.md`.

The build uses esbuild with `node20` as the target and produces `dist/plugin.mjs`, `dist/plugin/index.mjs`, `dist/server.mjs`, `dist/cli.mjs` and `dist/lexicon.ru-en.json`.

Design notes live in `docs/contract.md` and version history in `docs/CHANGELOG.md`.

## Security and privacy

The server is read-only: it opens `SKILL.md` files, never writes to them, and the CLI writes only to the opencode config and its own backup. Nothing calls the network, and no code path calls a model or another service. Paths are resolved against their root before a file is opened, so a `path` argument cannot reach outside the skill directories. Debug logs are opt-in and stay on the local disk.

## License

MIT, copyright 2026 Klaus101-ai (`LICENSE`). Bundled libraries and their licenses are listed in `THIRD_PARTY_NOTICES.md`: MiniSearch 7.2.0 (MIT) and jsonc-parser 3.3.1 (MIT). esbuild is a development dependency and ships nothing.

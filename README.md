<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/gitshow/banner-dark.svg">
  <img src="assets/gitshow/banner-light.svg" alt="skill-mcp — one 411-token hint instead of the 52,488-token skill catalog" width="800">
</picture>

# skill-mcp

**English** · [Русский](README.ru.md)

Your agent has hundreds of skills and ignores them — this hands it the right one, the rest stay out of context.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node: 20 or newer](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)
[![runtime dependencies: 0](https://img.shields.io/badge/runtime_dependencies-0-brightgreen.svg)](package.json)

A local MCP server and an opencode plugin. It indexes the `SKILL.md` files already on your machine, searches them when a message arrives, and puts the candidates plus the likely match into the request context. No network, no API keys, no model of its own.

The problem it solves: at each model step opencode lists every registered skill as id, name and description, and nothing more (see the skills guide under Loading). A skill whose description does not overlap the request stays invisible, and a message with no auto-match reads as if no skills exist, so the agent answers from general knowledge instead of opening the skill that fits.

## Demo

![skill-mcp demo: the full 416-skill catalog is 195,639 chars (~52,488 tokens) per request, the plugin hint is 1,380 chars (~411 tokens) and forms in 4.9 ms](assets/gitshow/demo.png)

Two panels from one measured run on 13.11.2026. Left: the catalog of 416 skills in the XML form opencode sends, 195,639 characters or about 52,488 tokens, paid on every request. Right: what the plugin adds for one message, 1,380 characters or about 411 tokens, built in 4.9 ms against a 150 ms budget. Under them are the two parts the plugin emits: the router rule (442 characters) and the `<skill_hint>` block for a Russian contract-review query (938 characters, 4 candidates), copied from the run without edits.

Both token counts use one estimate, ASCII characters divided by 4 plus non-ASCII divided by 3, so read them as a ratio rather than a tokenizer's answer. The image is assembled from the measured parts, not a terminal screenshot; the terminal run behind the index is below.

`node cli/smoke.mjs` on 13.11.2026: 416 `SKILL.md` found under 4 roots, index built in 760.7 ms, 5 queries with their top three and the fields that matched. The last query is Russian and comes back in Russian, because the index keeps both sides of the bridge.

## What you get

**The search runs before the answer.** A fixed rule goes to the front of the system prompt on every owner message and makes `find` the agent's first action. The gate backs it in code: until a `find` call is seen for the current message, every other tool call of the main session is refused (`plugin/hint.mjs:89-93`, `plugin/gate.mjs:12-14`).

**One hint instead of the whole catalog.** 1,380 characters (about 411 tokens) against 195,639 characters (about 52,488 tokens) for 416 skills: 52,077 tokens saved on a request, 99.2% less. With the body of the top skill preloaded (11,530 characters, about 3,565 tokens) the request carries about 3,976 tokens, which is still 92.4% less than the catalog. The catalog figure is the XML form of the same list opencode builds, measured on 13.11.2026 with the estimate above.

**Candidates arrive inside the same request.** The hint holds up to 5 candidates in 1000 characters and is built within 150 ms; the preload adds the body of the top confident skill up to 20000 characters (`plugin/hint.mjs:95-97,108`). The measured block used 4 candidates, 938 characters and 4.9 ms.

**Search reads Russian too.** BM25 over skill name, description and headings, plus a fixed RU to EN dictionary in `core/lexicon.ru-en.json`. A Russian query about a complaint to the antitrust service returns `biased-tender-detection` first and `fas-complaint-draft` second, with the Russian stems listed in `why` (`node cli/smoke.mjs`, run of 13.11.2026).

**Local and read-only by construction.** No runtime dependencies (`package.json:45`), no network call in the code, `SKILL.md` files opened read-only, and a path that resolves outside its skill root refused with `E_FORBIDDEN` (`core/sources.mjs:241`).

## Quick start

Requires Node.js 20 or newer (`package.json:8`). The package is not on the npm registry: build the tarball from a checkout.

```sh
git clone https://github.com/Klaus101-ai/skill-mcp.git
cd skill-mcp
npm install
npm pack
npm install -g ./skill-finder-mcp-<version>.tgz
skill-finder-mcp init
```

`npm pack` prints the file name with the version from `package.json:3`. `init` finds your opencode config, adds `mcp.skill-mcp` as a local stdio server and the plugin entry, prints the diff and saves a `.bak-YYYYMMDD-HHMM` copy before writing (`cli/main.mjs`). JSONC comments survive the edit, and a second run changes nothing.

Then check the whole chain and restart opencode:

```sh
skill-finder-mcp doctor
```

`doctor` checks Node, the config file, the MCP entry and the server file it points at, the plugin entry and the `index.mjs` inside the plugin directory, the skill roots and a probe search. Exit code 0 means every check passed (`cli/main.mjs`).

## Hide the built-in skill list

The list costs more than the hint. opencode writes the id, name and description of every permitted skill into the model's context at each step, and the 52,488-token figure above is that list for 416 skills. Two supported ways take it out, and skill-mcp keeps working with either.

There is no key that only stops the list. The `skills` array in `opencode.json` adds sources, it does not hide anything (`@opencode/schema/dist/config.d.ts:69`).

**1. Deny the `skill` action.** All skills leave the model's list, and loading by ID is rejected:

```json
{
  "permissions": [
    { "action": "skill", "resource": "*", "effect": "deny" }
  ]
}
```

Rules run in order and the last match wins, so a narrower `allow` placed after this line lets one skill back in. The shape of the triple is in the config schema (`@opencode/schema/dist/config.d.ts:47-55`), the behaviour in the skills guide under [Permissions](https://opencode.ai/docs/skills). The agent can still read a skill body through `outline` and `read-section`, which open the file themselves (`server/index.mjs:100,113`).

**2. Mark skills `autoinvoke: false`.** The skill stays registered and loadable by ID, and drops out of the model's list. In a skill's frontmatter:

```yaml
metadata:
  opencode/autoinvoke: false
```

`disable-model-invocation: true` has the same effect. From a plugin, `ctx.skill.transform(...)` sets the same field on a loaded skill and `ctx.skill.reload()` applies it (`node_modules/@opencode/plugin/dist/promise/skill.d.ts:13-14`; the field is `Skill.Info.autoinvoke` in `@opencode/schema/dist/skill.d.ts:25`).

Before you switch either one on:

- Built-in skills ship inside opencode and have no directory under any skill root. A deny removes them, and skill-mcp cannot index them because there is no file to walk. In the run above, all 416 indexed skills came from the four roots on disk.
- skill-mcp indexes files named `SKILL.md` only (`core/sources.mjs:174`). A flat `<root>/name.md` skill never appears in its results, and once the list is hidden it is invisible to the agent.
- The roots are the six paths under Configuration, all home or project scoped. A project `.claude/skills` or `.agents/skills` directory is not read, so skills that live only there have no fallback either (`core/sources.mjs:16-23`).
- Restart opencode after a config change. The list is built at load, not per message.

This section comes from the official documentation, read on 13.11.2026, and the permission triple was checked against the schema files. Neither recipe was exercised in a live run on this machine.

## How it works

The plugin adds three things to a request, all from the same index.

- `rule`: a fixed instruction block unshifted to the front of the system prompt on every owner message. It tells the agent to call `find` first and states that a missing hint block means no auto-match, not an empty skill folder. The rule fires even when nothing matched, and a marker keeps it to one copy per request.
- `preload`: the body of the top confident candidate, up to 20000 characters, as a `<skill_content>` part.
- `hint`: up to 5 candidates as a `<skill_hint>` part, 1000 characters max, built inside a 150 ms budget. Candidates without confidence are marked in the block.

The index warms up when the plugin loads, so the first request pays for a search rather than a full walk. A query that matches no skill produces no hint and no preload; the rule still goes in.

## Find gate

Until a `find` call is seen for the current owner message, the main session gets every other tool call refused. The refusal starts with `skill-mcp gate` and names the call to make.

These calls pass without `find`:

- `sequential_thinking`, `todowrite`, `todoread`, `question`, `skill`, `subagent` and `task` (`plugin/gate.mjs:54`);
- `execute` whose code calls `find`;
- `execute` whose code calls `sequential_thinking` and nothing else;
- every call in a subagent session, which is outside the gate.

A new owner message is recognised by the number of user messages plus the text of the last one; a new signature closes the gate again. Unreadable session state or an `execute` payload the gate cannot read allows the call instead of refusing it, which is the fail-open contract (`plugin/gate.mjs:14-15`). A missing or malformed config file does not: it leaves the gate on, which is the default. `SKILL_MCP_GATE=off` or `"gate": false` removes the layer.

## MCP server tools

| Tool | Arguments | Limits |
| --- | --- | --- |
| `find` | `query` (required), `limit`, `restrict_to` | `limit` 1 to 10, default 10; `restrict_to` takes names or globs |
| `outline` | `name`, or `path` to a `SKILL.md` | frontmatter plus headings with line numbers, 40 headings max, then `truncated: true` |
| `read-section` | `name`, `heading`, `max_lines` | `heading` is text or its 1-based number; `max_lines` 1 to 600, default 150 |

Three tools, declared in `server/index.mjs:60,100,113`. The server speaks JSON-RPC 2.0 on stdio, one message per line, and exits when stdin closes. Every tool schema declares `additionalProperties: false`, and arguments are type-checked before a search runs. Failures come back either as a JSON-RPC code (-32700 through -32603) or as a tool error: `E_INVALID_INPUT`, `E_NOT_FOUND`, `E_FORBIDDEN`, `E_SECTION_NOT_FOUND`, `E_UNAVAILABLE`. The index is built on first use and cached for the life of the process.

A `find` call over stdio, as the agent makes it:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find","arguments":{"query":"review a supply contract","limit":3}}}
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

It skips `node_modules`, `.git` and backup directories; the match is on a whole directory name (`core/sources.mjs:11`).

## Limitations

- Search is lexical. A request that shares no token with the name, description or headings of a skill will not find it.
- The RU to EN bridge is a fixed dictionary in `core/lexicon.ru-en.json`. Words outside it get no translation help.
- Candidate quality follows your frontmatter descriptions. A one-line description produces a thin hint.
- On the final acceptance set of 60 queries, recall@5 is 0.7600, the same as the lexical baseline, and NDCG@10 is 0.6274 against 0.6654 for that baseline (`measure/README.md`). The hint and the gate are the value; the ranking is not better than BM25.
- Latency figures in `measure/README.md` come from one machine and a 365-skill corpus. Treat them as a reference, not a promise.
- The gate covers tool calls only. A reply written without tools is not intercepted, and the rule text is the only thing asking for a search there.
- One test fails, so the suite is not green (see Development).
- There is no CI workflow in the repository. Tests run where you run them.

## Troubleshooting

Start with `skill-finder-mcp doctor`; it reports each piece separately and exits non-zero on a problem.

A refusal that keeps coming back is a gate question, not a search question. Set `SKILL_MCP_GATE_DEBUG=1` and read one line per decision in `~/.config/opencode/logs/skill-mcp-gate.log`. The file is created only while the switch is on.

No hint block in a request usually means no confident candidate for that message, or `SKILL_MCP_HINT=off` in the environment of the process that runs opencode. `SKILL_MCP_DEBUG=1` prints what the plugin decided to stderr.

If you turned on the skill permission from the section above, remember that the `skill` tool no longer loads anything. The hint still points at skill names; `read-section` reads the body from disk.

## Development

```sh
npm install
npm run build
npm test
```

`npm test` runs `node --test` over `test/`. On 13.11.2026 it reported 224 tests: 222 pass, 1 fail, 1 skipped. The failure is `test/pack.test.mjs:57`: `npm pack` picks up `README.md.bak-20261105-2124` and `README.ru.md`, both outside the allowed file set. Move the backup into `_backups/` and decide whether `README.ru.md` belongs in the package; until then the suite exits non-zero and this README does not claim otherwise.

`npm run smoke` runs the smoke script, which prints the skill count, the index build time and five queries with their top three (`cli/smoke.mjs`). `npm run measure` and `npm run latency` regenerate the numbers in `measure/README.md`.

The build uses esbuild with `node20` as the target and produces `dist/plugin.mjs`, `dist/plugin/index.mjs`, `dist/server.mjs`, `dist/cli.mjs` and `dist/lexicon.ru-en.json`.

Design notes live in `docs/contract.md` and version history in `docs/CHANGELOG.md`.

## Security and privacy

The server is read-only: it opens `SKILL.md` files, never writes to them, and the CLI writes only to the opencode config and its own backup. Nothing calls the network, and no code path calls a model or another service. Paths are resolved against their root before a file is opened, so a `path` argument cannot reach outside the skill directories. Debug logs are opt-in and stay on the local disk.

## License

MIT, copyright 2026 Klaus101-ai (`LICENSE`). Bundled libraries and their licenses are listed in `THIRD_PARTY_NOTICES.md`: MiniSearch 7.2.0 (MIT) and jsonc-parser 3.3.1 (MIT). esbuild is a development dependency and ships nothing.

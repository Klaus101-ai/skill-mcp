# skill-router

Local skill search and ranking for [opencode](https://opencode.ai). Indexes
`SKILL.md` files (frontmatter `name`, `description`, body headings) and answers
queries with a ranked list of matching skills. Everything runs locally:
**no network, no LLM, no embeddings, no API keys, files are read-only.**

Status: **M1** — core index, CLI smoke run, baseline evaluation. The MCP server
and the plugin are not implemented yet.

## Requirements

- Node.js >= 20
- One runtime dependency: [`minisearch`](https://github.com/lucaong/minisearch) 7.2.0 (MIT, BM25+)

## Install

```sh
npm install
```

## Usage

```sh
npm test        # unit tests (node:test)
npm run smoke   # build the index over the real skill roots, run 5 fixed queries
npm run measure # baseline BM25 recall@5 on the draft query set
```

Programmatic API (`core/`):

```js
import { defaultRoots, discoverSkills, resolveSkillPath } from "./core/sources.mjs";
import { buildIndex, search } from "./core/index.mjs";

const skills = discoverSkills(defaultRoots());
const index = buildIndex(skills);
const hits = search(index, "bug bounty report", { limit: 5 });
// -> [{ name, path, score, why }, ...]
```

- Field weights: `name` x3, `description` x2, `headings` x1.
- `why` is a single line, max 160 chars, explaining which fields matched.
- `restrict_to: ["name-or-glob*"]` filters results to an allowlist of skill names.
- Empty / whitespace / punctuation-only queries return `[]` — no random hints.

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

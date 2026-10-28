#!/usr/bin/env node
// skill-mcp MCP server — stdio transport, JSON-RPC 2.0, read-only (R5).
//
// Primary sources for the protocol behaviour (verified 2026-10-25):
//   lifecycle / initialize / version negotiation:
//     https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle.md
//     https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle.md
//   stdio framing (one JSON-RPC message per line, stdout = protocol only,
//   stderr = logs, exit on stdin EOF):
//     https://modelcontextprotocol.io/specification/2025-06-18/basic/transports.md
//     https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md
//   tools/list, tools/call, inputSchema, isError, unknown tool -> -32602:
//     https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md
//     https://modelcontextprotocol.io/specification/2025-06-18/server/tools.md
//   ping -> empty result:
//     https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping.md
//   JSON-RPC error codes (-32700/-32600/-32601/-32602/-32603):
//     https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md
//     https://www.jsonrpc.org/specification
//
// The client here (opencode) speaks the initialization-based ("legacy")
// handshake up to 2025-11-25 (node_modules/@opencode/schema/dist/mcp.js), so
// this server supports ["2025-11-25", "2025-06-18"] and echoes the requested
// version when supported, otherwise answers with its latest (2025-11-25).
import readline from "node:readline";
import fs from "node:fs";
import {
  defaultRoots,
  discoverSkills,
  resolveSkillPath,
  parseFrontmatter,
  extractHeadingEntries,
} from "../core/sources.mjs";
import { buildIndex, search, selectWinner } from "../core/index.mjs";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];
const MAX_HEADINGS = 40; // outline cap (spec 6.2)
const DEFAULT_MAX_LINES = 150; // read-section default (spec 6.3)
const MAX_MAX_LINES = 600; // read-section hard cap (spec 6.3)
const DEFAULT_LIMIT = 10; // find default (spec 6.1; v0.4.1 owner decision 26.10.2026: 10)
const MIN_LIMIT = 1;
const MAX_LIMIT = 10;

let serverVersion = "0.0.0";
try {
  serverVersion =
    JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ||
    "0.0.0";
} catch {
  // keep the fallback; package.json is only used for serverInfo.version
}

function log(...args) {
  if (process.env.SKILL_MCP_DEBUG ?? process.env.SKILL_ROUTER_DEBUG) process.stderr.write(`${args.join(" ")}\n`);
}

const TOOLS = [
  {
    name: "find",
    // v0.6.3 (owner task 27.10.2026, item 3 — find visibility): the Code Mode
    // catalog shows the CHEAPEST line of each namespace (opencode L1/f1: one
    // listing per namespace, cost = round(line.length/4), round-robin inside a
    // 2000-cost budget). The old one-line description put find's listing at
    // cost 115 while outline sat at 76, so the catalog showed `outline`. The
    // description now LEADS with a short first line (the only part the catalog
    // renders — first line, ≤120 chars) and the parameter semantics moved from
    // the inputSchema property descriptions (they inflate every signature by
    // one JSDoc comment per property) into the lines below; types, required,
    // default/minimum/maximum are untouched, so the callable schema keeps its
    // validation fields (and `limit` still renders @default/@minimum/@maximum).
    description:
      "Call this FIRST when a request may need a skill; returns up to 10 candidates.\n" +
      "Read the descriptions and choose the skill that matches the user's request — examples: writing text, landing page, design, code, legal, research. confident:true marks the likely match — verify it against its description before loading. Load the chosen skill with the skill tool before answering and follow its instructions; if no candidate matches, proceed without a skill.\n" +
      "Local full-text search over SKILL.md files (BM25 over name, description and headings). Read-only. Returns {ok, items:[{name,path,score,why,description,confident}], next}. limit: how many results (1-10, default 10). restrict_to: keep only these skill names or glob patterns.\n" +
      "confident marks positions covering >= need significant query tokens of the expanded query: need = 1 for a 1-2 token query, need = 2 from 3 tokens on (v0.6.3). v0.4.1: «описание» adds «текст», «продукт» adds «product», domain skills from BOOST_ORDER are boosted to the top of the pool. The hint shows up to 5 candidates, confident first.",
    inputSchema: {
      type: "object",
      properties: {
        // No per-property `description` (v0.6.3): they are what made find the
        // priciest listing line in the Code Mode catalog; the meaning of every
        // parameter is spelled out in the tool description above.
        query: { type: "string" },
        limit: {
          type: "integer",
          minimum: MIN_LIMIT,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
        },
        restrict_to: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "outline",
    description:
      "Table of contents of one skill: frontmatter name/description plus headings with 1-based line numbers (max 40 headings, truncated:true on overflow).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        path: { type: "string", description: "Alternative to name: path to a SKILL.md inside a skill root." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read-section",
    description:
      "Read one section of a skill body: from the heading line up to the next heading of the same level (max 600 lines, truncated:true on overflow).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        heading: {
          anyOf: [{ type: "string" }, { type: "integer" }],
          description: "Heading text without '#', or its 1-based number in outline order.",
        },
        max_lines: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MAX_LINES,
          default: DEFAULT_MAX_LINES,
          description: `Maximum lines to return (default ${DEFAULT_MAX_LINES}, max ${MAX_MAX_LINES}).`,
        },
      },
      required: ["name", "heading"],
      additionalProperties: false,
    },
  },
];

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
class UnavailableError extends Error {}

// --- lazy index (built on the first tool call, cached forever) -------------
let state = null;
function getIndex() {
  if (state) return state;
  let roots;
  try {
    roots = defaultRoots();
  } catch (err) {
    throw new UnavailableError(`каталоги скиллов недоступны: ${err.message}`);
  }
  if (roots.length === 0) {
    throw new UnavailableError("каталоги скиллов недоступны: ни один корень не найден");
  }
  const { skills } = discoverSkills(roots); // throws nothing today, kept defensive
  const index = buildIndex(skills);
  state = { roots, skills, index };
  log(`index built: ${skills.length} skills from ${roots.length} roots`);
  return state;
}

// --- shared skill resolution (winner rule lives in core/index.mjs) ---------
function resolveByName(st, name) {
  const candidates = st.skills.filter((s) => s.name === name);
  if (candidates.length === 0) return null;
  // Winner rule (core/index.mjs): highest search score when the query matched,
  // otherwise the lexicographically first path; return the indexed skill so
  // that `root` is available for the AC4 boundary check.
  const hits = search(st.index, name, { limit: MAX_LIMIT }).filter((r) => r.name === name);
  const winner = selectWinner(hits) || selectWinner(candidates);
  return candidates.find((s) => s.path === winner.path) || selectWinner(candidates);
}

function resolveByPath(st, target) {
  let forbidden = false;
  for (const root of st.roots) {
    try {
      const real = resolveSkillPath(target, root); // AC4 boundary check
      const skill = st.skills.find((s) => s.path === real);
      if (skill) return skill;
      // inside a root but not indexed (e.g. a skipped backup dir)
      throw new ToolError("E_NOT_FOUND", "скилл не найден");
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if (err.code === "E_FORBIDDEN") forbidden = true;
      // E_NOT_FOUND: try the next root
    }
  }
  if (forbidden) throw new ToolError("E_FORBIDDEN", "путь вне каталогов скиллов");
  throw new ToolError("E_NOT_FOUND", "скилл не найден");
}

function readSkillFile(st, skill) {
  // AC4: even index-sourced paths go through resolveSkillPath before reading.
  const real = resolveSkillPath(skill.path, skill.root);
  return fs.readFileSync(real, "utf8"); // read-only
}

function invalidInput(message) {
  return { ok: false, error: { code: "E_INVALID_INPUT", message } };
}
function notFound() {
  return { ok: false, error: { code: "E_NOT_FOUND", message: "скилл не найден" } };
}

// --- tools ----------------------------------------------------------------
function toolFind(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalidInput("find: аргументы должны быть объектом");
  }
  if (typeof args.query !== "string") {
    return invalidInput("find: query должен быть строкой");
  }
  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit)) {
      return invalidInput("find: limit должен быть целым числом");
    }
    if (args.limit < MIN_LIMIT || args.limit > MAX_LIMIT) {
      return invalidInput(`find: limit вне диапазона ${MIN_LIMIT}-${MAX_LIMIT}`);
    }
    limit = args.limit;
  }
  let restrictTo;
  if (args.restrict_to !== undefined) {
    if (!Array.isArray(args.restrict_to) || args.restrict_to.some((x) => typeof x !== "string")) {
      return invalidInput("find: restrict_to должен быть массивом строк");
    }
    restrictTo = args.restrict_to;
  }

  if (args.query === "") return { ok: true, items: [], note: "пустой запрос" };

  const st = getIndex(); // may throw UnavailableError
  // v0.4 (owner decision 26.10.2026 — candidate list, the agent chooses):
  // `find` returns up to `limit` candidates (default 10 since v0.4.1, max 10),
  // each position carrying `confident` and the skill `description`. The
  // coverage rule does not filter this list — it only decides the `note` (and
  // the plugin hint, which shows up to 5 candidates, confident first). AC3 is
  // now «кандидаты, не утверждение»: candidates, not a claim (docs/contract.md).
  // v0.4.1 (variant G): the expansion («описание»→«текст», «продукт»→«product»)
  // and the BOOST_ORDER domain boost happen inside core `search` — `find`
  // receives them automatically.
  const items = search(st.index, args.query, { limit, restrict_to: restrictTo });
  if (items.length === 0) return { ok: true, items: [], note: "ничего не найдено" };
  // v0.6.2 (owner task 27.10.2026 — «посмотри описания, потом загрузи»): every
  // non-empty result carries a top-level `next`. A confident FIRST item gets a
  // likely-match line (name included); otherwise the agent is told to compare
  // the candidate descriptions and load the skill that matches. Empty results
  // carry no `next` — there is nothing to review.
  const first = items[0];
  const next =
    first && first.confident === true
      ? `likely match: ${first.name} — verify its description and load it`
      : "review the candidate descriptions; load the matching skill";
  if (!items.some((it) => it && it.confident === true)) {
    return { ok: true, items, note: "уверенных нет, вот возможные", next };
  }
  return { ok: true, items, next };
}

function toolOutline(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalidInput("outline: аргументы должны быть объектом");
  }
  if (args.name !== undefined && typeof args.name !== "string") {
    return invalidInput("outline: name должен быть строкой");
  }
  if (args.path !== undefined && typeof args.path !== "string") {
    return invalidInput("outline: path должен быть строкой");
  }
  const hasName = typeof args.name === "string" && args.name.trim() !== "";
  const hasPath = typeof args.path === "string" && args.path.trim() !== "";
  if (!hasName && !hasPath) {
    return invalidInput("outline: требуется name или path");
  }

  const st = getIndex();
  const skill = hasName ? resolveByName(st, args.name.trim()) : resolveByPath(st, args.path.trim());
  if (!skill) return notFound();

  const text = readSkillFile(st, skill);
  const fm = parseFrontmatter(text);
  const entries = extractHeadingEntries(text);
  const overflow = entries.length > MAX_HEADINGS;
  const headings = entries.slice(0, MAX_HEADINGS).map((e) => ({ level: e.level, text: e.text, line: e.line }));
  const description = String(fm.data.description || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s !== "") || "";

  const out = {
    ok: true,
    name: skill.name,
    path: skill.path,
    description,
    headings,
  };
  if (overflow) out.truncated = true;
  return out;
}

function toolReadSection(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalidInput("read-section: аргументы должны быть объектом");
  }
  if (typeof args.name !== "string" || args.name.trim() === "") {
    return invalidInput("read-section: name обязателен и должен быть строкой");
  }
  const h = args.heading;
  if (h === undefined || h === null) {
    return invalidInput("read-section: heading обязателен");
  }
  if (typeof h !== "string" && typeof h !== "number") {
    return invalidInput("read-section: heading должен быть строкой или целым числом");
  }
  if (typeof h === "number" && !Number.isInteger(h)) {
    return invalidInput("read-section: heading-номер должен быть целым числом");
  }
  let maxLines = DEFAULT_MAX_LINES;
  if (args.max_lines !== undefined) {
    if (typeof args.max_lines !== "number" || !Number.isInteger(args.max_lines)) {
      return invalidInput("read-section: max_lines должен быть целым числом");
    }
    if (args.max_lines < 1 || args.max_lines > MAX_MAX_LINES) {
      return invalidInput(`read-section: max_lines вне диапазона 1-${MAX_MAX_LINES}`);
    }
    maxLines = args.max_lines;
  }

  const st = getIndex();
  const skill = resolveByName(st, args.name.trim());
  if (!skill) return notFound();

  const text = readSkillFile(st, skill);
  const entries = extractHeadingEntries(text);
  const sectionNotFound = () => ({
    ok: false,
    error: { code: "E_SECTION_NOT_FOUND", message: "заголовок не найден" },
  });

  let idx = -1;
  if (typeof h === "number") {
    if (h < 1 || h > entries.length) return sectionNotFound();
    idx = h - 1;
  } else {
    const want = h.trim().replace(/^#+\s*/, "").trim();
    if (want === "") return invalidInput("read-section: heading пуст");
    idx = entries.findIndex((e) => e.text === want);
    if (idx < 0 && /^\d+$/.test(want)) {
      const n = Number(want);
      if (n >= 1 && n <= entries.length) idx = n - 1;
    }
    if (idx < 0) return sectionNotFound();
  }

  const startLine = entries[idx].line;
  let endLine = text.split(/\r?\n/).length; // inclusive
  for (let i = idx + 1; i < entries.length; i += 1) {
    if (entries[i].level === entries[idx].level) {
      endLine = entries[i].line - 1;
      break;
    }
  }

  const all = text.split(/\r?\n/).slice(startLine - 1, endLine);
  const truncated = all.length > maxLines;
  const lines = truncated ? all.slice(0, maxLines) : all;

  return {
    ok: true,
    name: skill.name,
    heading: entries[idx].text,
    line_start: startLine,
    lines,
    truncated,
  };
}

const TOOL_HANDLERS = { find: toolFind, outline: toolOutline, "read-section": toolReadSection };

// --- JSON-RPC --------------------------------------------------------------
function handleInitialize(params) {
  const requested =
    params && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
  const protocolVersion =
    requested && PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "skill-mcp", title: "skill-mcp", version: serverVersion },
    instructions:
      // v0.6.3 (item 3): lead with `find` — the namespace line the Code Mode
      // catalog renders as `- skill-mcp (…)` starts with this text.
      "Read-only search over local SKILL.md files. Start with find (search), then outline (headings) and read-section (one section).",
  };
}

function handleToolsCall(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { error: { code: -32602, message: "Invalid params: params must be an object" } };
  }
  if (typeof params.name !== "string") {
    return { error: { code: -32602, message: "Invalid params: params.name (string) is required" } };
  }
  const name = params.name;
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    // MCP tools spec: unknown tool is a protocol error -32602.
    return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  let payload;
  try {
    payload = handler(args);
  } catch (err) {
    if (err instanceof UnavailableError) {
      payload = { ok: false, error: { code: "E_UNAVAILABLE", message: err.message } };
    } else if (err instanceof ToolError) {
      payload = { ok: false, error: { code: err.code, message: err.message } };
    } else if (err && (err.code === "E_NOT_FOUND" || err.code === "E_FORBIDDEN")) {
      // Path guard errors from core/sources.mjs surface as tool payloads.
      payload = { ok: false, error: { code: err.code, message: err.message } };
    } else {
      return { error: { code: -32603, message: `Internal error: ${err && err.message ? err.message : String(err)}` } };
    }
  }
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: payload.ok === false,
    },
  };
}

function dispatch(msg) {
  switch (msg.method) {
    case "initialize":
      return { result: handleInitialize(msg.params) };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: TOOLS } };
    case "tools/call":
      return handleToolsCall(msg.params);
    default:
      return { error: { code: -32601, message: "Method not found", data: { method: msg.method } } };
  }
}

function write(msg) {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch (err) {
    log(`stdout write failed: ${err.message}`);
  }
}

// --- stdio loop ------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const raw = line.trim();
  if (raw === "") return; // blank line: not a message, no response

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    const id =
      msg && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
    write({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  if (msg.method.startsWith("notifications/")) return; // notifications get no response
  if (!Object.prototype.hasOwnProperty.call(msg, "id")) return; // a request without id: ignore

  const id = msg.id;
  if (id === null || (typeof id !== "string" && typeof id !== "number")) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }

  const out = dispatch(msg);
  if (out.error) write({ jsonrpc: "2.0", id, error: out.error });
  else write({ jsonrpc: "2.0", id, result: out.result });
});

// stdin EOF / close is the documented graceful shutdown: no timers, no other
// handles, the event loop drains and the process exits with code 0.
rl.on("close", () => log("stdin closed, exiting"));

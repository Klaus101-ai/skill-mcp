// skill-mcp — context hint hook logic («secretary»), spec §7, R1–R6.
//
// Pure ESM, no build step. Imported by:
//   - plugin/skill-mcp-hint.ts — the file opencode loads as a plugin;
//   - test/plugin.test.mjs and cli/plugin-demo.mjs — plain Node, no opencode.
//
// Contract (spec §7, §8, R1–R6):
//   - the hint is one text part appended to `system` before a model dispatch;
//   - never claims a skill is loaded (R1): the `note` attribute is verbatim
//     (a claim of a load would be false — the preloaded content below is the
//     content itself, not a claim);
//   - deny/allow by agent (R2), default = hint everything except `deny`;
//   - does not replace the mandatory «Скиллы» field (R3) — it is text only;
//   - calls no tools, writes no files, emits no skill-gate events (R4); the
//     v0.6.3 preload (owner task 27.10.2026, item 4) only READS a SKILL.md;
//   - read-only, local: no network, no LLM, no keys (R5);
//   - fail-open, `SKILL_MCP_HINT=off` switch (legacy `SKILL_ROUTER_HINT` = deprecated fallback), ≤5 items / ≤1000 chars /
//     ≤150 ms budget (R6, v0.4).
//
// v0.6.3 (owner task 27.10.2026 — «Все 4 пункта»), two additions:
//   1. PRE-WARM: `createContextHook` schedules `ensureIndex()` on `setImmediate`,
//      i.e. the index is built at plugin load, OUTSIDE the first user request —
//      the first hint then pays only the search and fits the 150 ms budget.
//      Non-blocking (the factory returns before the build), fail-open (a build
//      error is cached as failed), skipped entirely when the hint is off;
//   2. PRELOAD: after a hint block forms, the TOP `confident` candidate's
//      SKILL.md body is appended as a second system part — opencode's own
//      `<skill_content name="…">` shape — BEFORE the hint part, so the hint
//      stays the last part. `SKILL_MCP_PRELOAD=off|0|false` disables the
//      preload (the hint itself is unaffected); an unreadable/out-of-root path
//      or a missing file just means no content part (fail-open).
//
// v0.4 (owner decision 26.10.2026 — «5 кандидатов», the MCP stops claiming a
// single answer): `search()` still returns the full list with a `confident`
// flag per position; this hint now shows UP TO 5 CANDIDATES taken from the
// ranked list (confident:true ranks first — v0.3.1 order), marking every
// `confident:false` entry with «(возможно)». The block is candidates, not a
// claim: AC3 is rephrased as «кандидаты, не утверждение» — candidates, not an
// assertion.
//
// v0.6.2 (owner task 27.10.2026 — «посмотри описания и выбери»): the note no
// longer says «кандидаты, не загрузка … выбери сам». It now tells the agent to
// READ the candidate descriptions and LOAD the matching skill through the
// `skill` tool (or load nothing when no candidate fits) — «candidates» must
// not read as permission to skip loading a skill that does match.
//
// Read-only by contract: this module opens files for reading only.
//
// v0.4.1 (owner decision 26.10.2026 — variant G): two silences and one gate,
// ported from the variants lab (variant «G synonyms»):
//   - tool-silence (`isToolSilent`): a question ABOUT the plugin/router/MCP
//     itself («почему плагин не нашёл…») gets NO hint — the model must answer
//     the user, not open a skill;
//   - confident gate: when the pool (search's top-10 — expansion and domain
//     boost live inside core `search` since v0.4.1) holds no `confident:true`
//     position, no block is built at all; unconfirmed candidates may appear
//     only behind a proven one, still marked «(возможно)».
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills, parseFrontmatter, resolveSkillPath } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";

/** `source` attribute of the block (spec §7). */
export const HINT_SOURCE = "skill-mcp";
/** The verbatim R1 note attribute — embedded in the block as-is, never mutated by the hook (wording fixed by the owner task 27.10.2026, v0.6.2). */
export const HINT_NOTE = "посмотри описания кандидатов; если один подходит — загрузи его через skill; если нет — не загружай.";
/** Opening tag prefix used both to build the block and to detect a duplicate. */
export const HINT_TAG = `<skill_hint source="${HINT_SOURCE}" note="${HINT_NOTE}">`;
/** Marker of an already-present hint (idempotency guard, keeps R6 budget). */
export const HINT_MARKER = `<skill_hint source="${HINT_SOURCE}"`;

// ── v0.6.4 ROUTER RULE (owner task 28.10.2026, phase 1a; phase 2 «усилить
// правило», owner decision 28.10.2026) ──────────────────────────────────────
// An always-on instruction UNSHIFTED to the FRONT of `system` (phase 2: the
// model must meet the rule before everything else, including the preamble):
// the model is told to run the skill-mcp `find` itself as the FIRST action,
// before any substantive work. Phase 2 also moved the rule insertion BEFORE
// the tool-silence check — the rule fires EVEN UNDER tool-silence (silence
// applies to the candidates hint only) and EVEN WHEN no confident candidate
// was found — the point of the rule: «no auto-match» is not «no skills», the
// model must check by itself. Idempotent via RULE_MARKER; disabled by
// `SKILL_MCP_RULE=off|0|false` (rule only) or config `"rule": false`;
// `SKILL_MCP_HINT=off` disables both (the hook returns before the rule).
/** Marker of an already-present router rule (idempotency guard). */
export const RULE_MARKER = "<skill_router_rule>";
/** The verbatim rule text (owner task 28.10.2026, phase 1a; phase 2 «усилить правило» — budget ≤500 chars). */
export const ROUTER_RULE = [
  RULE_MARKER,
  "Первое действие в задаче — вызови find сервера skill-mcp с запросом из задачи. До этого не начинай правки, проверки и содержательные ответы. Если кандидат подходит — загрузи его через skill; скрытые из каталога скиллы тоже доступны через find. Нет блока <skill_hint> — значит «автосовпадения нет», а не «скиллов нет»: проверь сам. Пропуск = задача не выполнена.",
  "</skill_router_rule>",
].join("\n");

export const MAX_ITEMS = 5; // R6, v0.4: up to 5 candidates
export const MAX_BLOCK_CHARS = 1000; // R6
export const BUDGET_MS = 150; // R6
const SEARCH_LIMIT = 10; // candidate pool before the deny/allow filters
const WHY_MAX = 120; // per-entry «зачем» line cap (block stays ≤1000 chars)
const OFF_VALUES = new Set(["off", "0", "false"]);
const LETTERS_RE = /\p{L}/u;

// ── v0.6.3 preload (owner task 27.10.2026, item 4) ─────────────────────────
// Private on purpose: the product surface is the env switch, the tests drive
// it through `createContextHook({ env })` (plugin/hint.d.mts stays untouched).
const PRELOAD_ENV = "SKILL_MCP_PRELOAD"; // off/0/false disables the content part
const SKILL_CONTENT_TAG = '<skill_content name="'; // opencode's own skill-content shape
const SKILL_CONTENT_MAX = 20000; // cap of the preloaded body (context budget)

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * Default config location (v0.6.0, owner task): the USER's config lives at
 * `~/.config/opencode/skill-mcp.config.json`. `SKILL_MCP_CONFIG` overrides it.
 * When the user config is absent, the hook falls back to the module-adjacent
 * `skill-mcp.config.json` (a dev/repo convenience); when neither exists the
 * in-code defaults apply (fail-open). `DEFAULT_CONFIG_PATH` itself is the
 * user-level path — the documented, stable location.
 */
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "skill-mcp.config.json");
/** Dev/repo fallback: the config file shipped next to this module. */
export const MODULE_CONFIG_PATH = path.join(HERE, "skill-mcp.config.json");

/**
 * Resolve which config file to read: `options.configPath` (explicit, tests) >
 * `SKILL_MCP_CONFIG` env > the user path if it exists > the module-adjacent
 * fallback. Returns a path; a missing file is handled fail-open by loadConfig.
 */
export function resolveConfigPath(options = {}, env = process.env) {
  if (typeof options.configPath === "string" && options.configPath) return options.configPath;
  const fromEnv = typeof env.SKILL_MCP_CONFIG === "string" ? env.SKILL_MCP_CONFIG.trim() : "";
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) return DEFAULT_CONFIG_PATH;
  } catch {
    /* fall through to the module path */
  }
  return MODULE_CONFIG_PATH;
}

function errMsg(err) {
  return err && err.message ? String(err.message) : String(err);
}

/** `off` / `0` / `false` (case-insensitive, trimmed) disable the hint (R6). */
export function isHintOff(value) {
  return OFF_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/**
 * A debug sink: `options.debug` may be a writer function or a boolean;
 * otherwise `SKILL_MCP_DEBUG=1` in the hook's env enables it (legacy `SKILL_ROUTER_DEBUG` = deprecated fallback). Output goes
 * to stderr only — never into the model context.
 */
function makeDebug(options, env) {
  if (typeof options.debug === "function") return options.debug;
  const enabled = options.debug === true || (options.debug === undefined && String(env.SKILL_MCP_DEBUG ?? env.SKILL_ROUTER_DEBUG ?? "") === "1");
  if (!enabled) return () => {};
  return (msg) => {
    try {
      process.stderr.write(`[skill-mcp] ${msg}\n`);
    } catch {
      /* stderr must never break the session */
    }
  };
}

function normalizeAgentList(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/** Shape: { rule?: boolean, deny: {agent: [pattern]}, allow: {agent: [pattern]} }; junk → defaults (rule stays on). */
export function normalizeConfig(raw) {
  const cfg = { rule: true, deny: {}, allow: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cfg;
  if (typeof raw.rule === "boolean") cfg.rule = raw.rule;
  for (const field of ["deny", "allow"]) {
    const src = raw[field];
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    for (const [agent, list] of Object.entries(src)) {
      cfg[field][agent] = normalizeAgentList(list);
    }
  }
  return cfg;
}

/**
 * Load `skill-mcp.config.json`. A missing file means the default (hint
 * everything); an unreadable/malformed file falls back to the default too —
 * a config problem must never break the session (fail-open), it only shows up
 * in stderr when debug is on.
 */
function loadConfig(configPath, debug) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8"); // read-only
  } catch (err) {
    if (err && err.code !== "ENOENT") debug(`config not readable (${configPath}): ${errMsg(err)}`);
    return normalizeConfig(null);
  }
  try {
    return normalizeConfig(JSON.parse(text));
  } catch (err) {
    debug(`config malformed (${configPath}): ${errMsg(err)} — defaults applied`);
    return normalizeConfig(null);
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Exact name match or `*`-glob, case-insensitive — the same semantics as
 * `restrict_to` in core/index.mjs so allow/deny agree with core filtering.
 */
export function nameMatches(name, patterns) {
  const raw = String(name);
  const lower = raw.toLowerCase();
  for (const p of patterns) {
    const pat = String(p);
    if (pat.includes("*")) {
      const rx = new RegExp(`^${escapeRegex(pat).replace(/\\\*/g, ".*")}$`, "i");
      if (rx.test(raw)) return true;
    } else if (lower === pat.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/** Last user message text (spec: «текст последнего пользовательского сообщения»). */
function lastUserText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const text = content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
    return text; // only the LAST user message; no fallback to earlier ones
  }
  return "";
}

/** One line, no angle brackets, ≤120 chars (WHY_MAX) — safe for the entry
 * line (§7). Brackets are stripped so a third-party description can never
 * fake or break the `<skill_hint>` envelope; whitespace (incl. newlines)
 * collapses to one line. */
function sanitizeWhy(value) {
  if (typeof value !== "string") return "";
  const one = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (!one) return "";
  if (one.length > WHY_MAX) return `${one.slice(0, WHY_MAX - 3)}...`;
  return one;
}

/** First line of `description` as the «зачем» of an entry (§7), sanitized. */
function cleanWhy(description) {
  if (typeof description !== "string" || !description.trim()) return "";
  return sanitizeWhy(description.split(/\r?\n/, 1)[0]);
}

// ── v0.4.1 tool-silence (variant G) ────────────────────────────────────────
// A question about the ROUTER ITSELF («почему плагин не нашёл / не активировал»)
// must not be answered with skill candidates: the model should explain the
// tool's behaviour, not open a skill. BOTH halves are required — the tool
// word AND the complaint word — so «настрой плагин для проекта» (no
// complaint) still gets a hint. Regexes are verbatim from the lab (G).
const TOOL_RX = /(плагин|skill[-_ ]?router|skill[-_ ]?mcp|\bmcp\b|скилл[-_ ]?мцп|мцп|скилл[-_ ]?роутер|роутер скиллов)/iu;
const QUIET_RX = /(почему|не\s*нашел|не\s*нашёл|не\s*активировал|не\s*работает)/iu;

/** v0.4.1: a complaint/question about the tool itself → no hint at all. */
export function isToolSilent(query) {
  return typeof query === "string" && TOOL_RX.test(query) && QUIET_RX.test(query);
}

// A skill name must not break the one-line entry format `- <имя>: ...; ...,
// name=<имя>` (no whitespace, `:`, `;`, `<`, `>`); such skills are skipped.
const SAFE_NAME_RE = /^[^\s:;<>]+$/u;

/**
 * The block, exactly per spec §7 (R1), v0.4 form. `items` —
 * [{name, why, confident}], ≤5; a `confident:false` entry is marked
 * «(возможно)» after its name. Entries are appended while the whole block
 * fits the ≤1000-char budget — when the tail does not fit it is DROPPED
 * (never an empty block in its place: budget overrun trims, it does not
 * silence). Returns "" only when there is nothing to hint.
 */
export function buildHintBlock(items) {
  const list = [];
  if (Array.isArray(items)) {
    for (const it of items) {
      if (!it || typeof it.name !== "string" || !SAFE_NAME_RE.test(it.name)) continue;
      const why = sanitizeWhy(it.why);
      if (!why) continue;
      list.push({ name: it.name, why, confident: it.confident === true });
      if (list.length >= MAX_ITEMS) break;
    }
  }
  if (list.length === 0) return "";
  let block = HINT_TAG;
  let kept = 0;
  for (const it of list) {
    const label = it.confident ? `${it.name}` : `${it.name} (возможно)`;
    const line = `- ${label}: ${it.why}; открыть: инструмент skill, name=${it.name}`;
    const next = `${block}\n${line}\n</skill_hint>`;
    if (next.length > MAX_BLOCK_CHARS) break; // budget guard (R6): drop the tail
    block = `${block}\n${line}`;
    kept += 1;
  }
  if (kept === 0) return ""; // not even one entry fits — nothing to hint
  return `${block}\n</skill_hint>`;
}

// ── v0.6.3 preload: the confident candidate's SKILL.md as <skill_content> ──
// Shape mirrors opencode's own skill output (`<skill_content name="…">`,
// `# Skill: …`, body, base directory, `<skill_files>`) so the model meets the
// same structure the `skill` tool returns — «a skill that is already present
// this way does not need to be invoked again». READ-ONLY: one SKILL.md read
// plus one directory listing inside the skill root (AC4 boundary via
// `resolveSkillPath`, the same guard the MCP server applies), nothing else.
// Returns "" (no part) on any problem — the hint itself must survive.
//
// Why the BODY and not an `@<skill-id>` mention (owner item 4, fallback
// branch): in opencode v2 an @skill mention is a STRUCTURED message part
// produced by the TUI — the @ autocomplete pushes `{type:"skill", value:{id,
// mention}}` with extmarks (bundle sites 142442554 / 142446037 / 142474618;
// a text scan for "@skill" finds nothing), while a plugin `context` hook may
// only append plain-text system parts. Injected "@promo" would therefore stay
// inert text; `<skill_content>` needs no parser — it is the shape opencode
// itself injects (bundle site 146282576).
function buildSkillContent(state, hit, debug) {
  try {
    const skill = state.byPath.get(hit.path);
    if (!skill || !skill.path || !skill.root) return ""; // no indexed file → no content
    const real = resolveSkillPath(skill.path, skill.root); // throws outside the root
    const raw = fs.readFileSync(real, "utf8"); // read-only, like every other read here
    let body = String(parseFrontmatter(raw).body ?? "").trim();
    // A body must never carry the hint idempotency marker (it would make the
    // next dispatch believe the hint is already present).
    body = body.split("<skill_hint source=").join("&lt;skill_hint source=");
    if (body.length > SKILL_CONTENT_MAX) {
      body = `${body.slice(0, SKILL_CONTENT_MAX)}\n[содержимое обрезано по лимиту ${SKILL_CONTENT_MAX} символов]`;
    }
    const dir = path.dirname(real);
    let files = "";
    try {
      const names = fs
        .readdirSync(dir)
        .filter((n) => n !== "SKILL.md")
        .sort()
        .slice(0, 10);
      files = names.length
        ? `Note: file list is sampled.\n\n<skill_files>\n${names.map((n) => `<file>${n}</file>`).join("\n")}\n</skill_files>`
        : "<skill_files>\n</skill_files>";
    } catch {
      /* no directory listing → the content block simply carries no <skill_files> */
    }
    const lines = [
      `${SKILL_CONTENT_TAG}${skill.name}">`,
      `# Skill: ${skill.name}`,
      "",
      body,
      "",
      `Base directory for this skill: ${dir}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    ];
    if (files) lines.push("", files);
    lines.push("</skill_content>");
    return lines.join("\n");
  } catch (err) {
    debug(`skill preload skipped (${hit.name}): ${errMsg(err)}`);
    return "";
  }
}

/**
 * Create the `context`-hook callback.
 *
 * One factory call = one index cache: `setup()` in skill-mcp-hint.ts calls
 * it once per opencode process, so the index is built once per process on the
 * first hook invocation and never rebuilt (spec §7).
 *
 * `options` (all optional, used by tests/demo):
 *   env         — environment object (default process.env)
 *   debug       — writer fn | boolean; default: SKILL_MCP_DEBUG=1 (legacy SKILL_ROUTER_DEBUG)
 *   configPath  — config file path (default: next to this module)
 *   config      — parsed config object (skips file loading)
 *   roots       — skill roots (default: core defaultRoots())
 *   discover / buildIndex / search — core overrides (fail-open tests)
 *   now         — clock, default performance.now()
 */
export function createContextHook(options = {}) {
  const env = options.env ?? process.env;
  const debug = makeDebug(options, env);
  const clock = options.now ?? (() => performance.now());
  const config = options.config ?? loadConfig(resolveConfigPath(options, env), debug);
  const roots = options.roots;
  const discover = options.discover ?? discoverSkills;
  const build = options.buildIndex ?? buildIndex;
  const query = options.search ?? search;

  // Index cache for this hook instance — built once, then reused; a failed
  // build is cached as failed so it is not retried on every model step.
  let cached = null;
  function ensureIndex() {
    if (cached !== null) return cached;
    try {
      const found = discover(roots ?? defaultRoots());
      const skills = Array.isArray(found?.skills) ? found.skills : [];
      if (skills.length === 0) {
        cached = { ok: false };
        debug("index not built: no skill roots or no SKILL.md files");
        return cached;
      }
      const byPath = new Map();
      for (const s of skills) if (s && s.path) byPath.set(s.path, s);
      cached = { ok: true, index: build(skills), byPath, count: skills.length };
      debug(`index built once: ${skills.length} skills`);
    } catch (err) {
      cached = { ok: false };
      debug(`index build failed: ${errMsg(err)}`);
    }
    return cached;
  }

  // v0.6.3 PRE-WARM (owner task 27.10.2026, item 2): build/heat the index at
  // plugin load, i.e. OUTSIDE the first user request. `setImmediate` keeps the
  // FACTORY non-blocking — `createContextHook()` (setup() in the plugin) is
  // back before a single file is read; by the time the first model dispatch
  // runs the index is warm and the hint formation is a search only, inside the
  // 150 ms BUDGET_MS guard (the budget itself is unchanged). No skills and a
  // failing discovery are both handled by `ensureIndex`'s own fail-open — the
  // scheduled call can not reject or crash plugin load. Nothing is scheduled
  // when the hint is disabled (no work for a hook that will not run).
  const hintDisabled = isHintOff(env.SKILL_MCP_HINT ?? env.SKILL_ROUTER_HINT);
  if (!hintDisabled) {
    const schedule = typeof setImmediate === "function" ? setImmediate : (fn) => void Promise.resolve().then(fn);
    schedule(() => {
      ensureIndex();
    });
  }

  // v0.6.3 PRELOAD switch: the content part follows the same off-set as the
  // hint (`off`/`0`/`false`, case-insensitive); default = enabled.
  const preloadEnabled = !isHintOff(env[PRELOAD_ENV]);

  // v0.6.4 ROUTER RULE switch (owner task 28.10.2026, phase 1a): env
  // `SKILL_MCP_RULE=off|0|false` disables ONLY the rule; config `"rule":
  // false` disables it too; a set env value WINS over config (priority env >
  // config). The hint switch `SKILL_MCP_HINT=off` still disables both — the
  // hook returns before the rule insert (phase 2: the rule is unshifted to
  // the front of `system`, before the tool-silence check). HINT_NOTE is
  // untouched.
  const envRuleRaw = typeof env.SKILL_MCP_RULE === "string" ? env.SKILL_MCP_RULE.trim() : "";
  const ruleEnabled = envRuleRaw !== "" ? !isHintOff(envRuleRaw) : config.rule !== false;

  return function contextHint(event) {
    try {
      if (isHintOff(env.SKILL_MCP_HINT ?? env.SKILL_ROUTER_HINT)) return; // AC7 (legacy SKILL_ROUTER_HINT = deprecated fallback)
      if (!event || !Array.isArray(event.system)) return;
      for (const part of event.system) {
        // Already hinted for this request — keep exactly one block (R6 budget).
        if (part && typeof part.text === "string" && part.text.includes(HINT_MARKER)) return;
      }
      const text = lastUserText(event.messages);
      if (!LETTERS_RE.test(text)) return; // no text / no letters → no hint, no rule

      // v0.6.4 ROUTER RULE (owner task 28.10.2026, phase 1a; phase 2 «усилить
      // правило» — owner decision 28.10.2026): inserted BEFORE the
      // tool-silence check (the rule fires even under tool-silence; silence
      // suppresses the HINT only) and UNSHIFTED to the FRONT of `system` —
      // the rule is the first thing the model sees. Fires even when no
      // confident candidate is found below: «no auto-match» is not «no
      // skills», the model must run `find` by itself. Idempotent: one rule
      // per request (RULE_MARKER guard). Cheap: no index, no I/O.
      if (ruleEnabled && !event.system.some((p) => p && typeof p.text === "string" && p.text.includes(RULE_MARKER))) {
        event.system.unshift({ type: "text", text: ROUTER_RULE });
      }

      // v0.4.1 (variant G): a question about the tool itself stays unanswered
      // by candidates — checked before the index lookup (no cost). Phase 2:
      // tool-silence gates the HINT only — the rule above has already fired.
      if (isToolSilent(text)) return;

      const t0 = clock();
      const state = ensureIndex();
      if (!state.ok) return;

      const agent = typeof event.agent === "string" ? event.agent : "";
      const hasAllow = Object.prototype.hasOwnProperty.call(config.allow, agent);
      const allowList = config.allow[agent] ?? [];
      const denyList = config.deny[agent] ?? [];

      const found = query(state.index, text, { limit: SEARCH_LIMIT });
      // v0.4.1 confident gate (variant G): the POOL (search's top-10 — expansion
      // and domain boost already applied inside core search) must hold at least
      // one `confident:true` position, otherwise no block is built at all.
      // Unconfirmed candidates may appear only behind a proven one, marked
      // «(возможно)» — the gate checks the pool, deny/allow filter it after.
      if (!Array.isArray(found) || !found.some((h) => h && h.confident === true)) return;
      const items = [];
      for (const hit of found) {
        // v0.4 (owner decision 26.10.2026 — 5 candidates, the model chooses):
        // no `confident` filter any more — the hook takes the first positions
        // of the ranked list (search already sorts `confident:true` first,
        // v0.3.1) up to MAX_ITEMS; `confident:false` entries are marked
        // «(возможно)» by buildHintBlock. The block states candidates, never a
        // single answer (AC3: «кандидаты, не утверждение»).
        if (!hit) continue;
        if (typeof hit.name !== "string" || !SAFE_NAME_RE.test(hit.name)) continue; // name must fit the entry line
        if (nameMatches(hit.name, denyList)) continue; // R2: deny wins
        if (hasAllow && !nameMatches(hit.name, allowList)) continue; // allow-only agent
        const why = cleanWhy(state.byPath.get(hit.path)?.description);
        if (!why) continue; // description is the only source of «зачем»
        // `path` travels with the item for the v0.6.3 preload lookup;
        // buildHintBlock reads only {name, why, confident}.
        items.push({ name: hit.name, path: hit.path, why, confident: hit.confident === true });
        if (items.length >= MAX_ITEMS) break;
      }
      const block = buildHintBlock(items);
      if (!block) return;

      const elapsed = clock() - t0;
      if (elapsed > BUDGET_MS) {
        debug(`hint dropped: formation took ${elapsed.toFixed(1)} ms > ${BUDGET_MS} ms`);
        return;
      }

      // v0.6.3 PRELOAD (owner task 27.10.2026, item 4): the TOP confident
      // candidate's SKILL.md body goes into `system` as its own part, BEFORE
      // the hint — the hint stays the last part and its R1 note stays verbatim,
      // so «загрузи его через skill» is never contradicted: what the note asks
      // for is already present as content for the likely match, and the other
      // candidates are still to be compared by description. Skipped when the
      // switch is off, when no candidate is confident (the gate already
      // guarantees one), when this part is present already (idempotent across
      // dispatches), or when the file can not be read (fail-open: hint alone).
      if (preloadEnabled) {
        const target = items.find((it) => it.confident);
        if (target) {
          const marker = `${SKILL_CONTENT_TAG}${target.name}">`;
          const already = event.system.some((p) => p && typeof p.text === "string" && p.text.includes(marker));
          if (!already) {
            const content = buildSkillContent(state, target, debug);
            if (content) {
              event.system.push({ type: "text", text: content });
              debug(`skill preloaded: ${target.name}`);
            }
          }
        }
      }

      // Mutation: one content part (optional, v0.6.3) + one text part at the
      // end of `system`. Messages, history, tools and options are untouched;
      // no tool is ever called (R3/R4).
      event.system.push({ type: "text", text: block });
    } catch (err) {
      debug(`hint skipped (fail-open): ${errMsg(err)}`); // R6
    }
  };
}

// skill-router — context hint hook logic («secretary»), spec §7, R1–R6.
//
// Pure ESM, no build step. Imported by:
//   - plugin/skill-router-hint.ts — the file opencode loads as a plugin;
//   - test/plugin.test.mjs and cli/plugin-demo.mjs — plain Node, no opencode.
//
// Contract (spec §7, §8, R1–R6):
//   - the hint is one text part appended to `system` before a model dispatch;
//   - never claims a skill is loaded (R1): the `note` attribute is verbatim;
//   - deny/allow by agent (R2), default = hint everything except `deny`;
//   - does not replace the mandatory «Скиллы» field (R3) — it is text only;
//   - calls no tools, writes no files, emits no skill-gate events (R4);
//   - read-only, local: no network, no LLM, no keys (R5);
//   - fail-open, `SKILL_ROUTER_HINT=off` switch, ≤2 items / ≤1000 chars /
//     ≤150 ms budget (R6).
//
// v0.3 (owner decision 26.10.2026 — search split from the hint): `search()`
// returns the full result list with a `confident` flag per position; this
// hint is built from `confident:true` positions only, so AC3 («no random
// hints») still holds for the hint while `find` may return non-confident
// positions. No confident position → no block (behaviour identical to an
// empty result).
//
// Read-only by contract: this module opens files for reading only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";

/** `source` attribute of the block (spec §7). */
export const HINT_SOURCE = "skill-router";
/** The verbatim R1 note attribute — never changed, never reworded. */
export const HINT_NOTE = "подсказка, не загрузка: скилл не открыт";
/** Opening tag prefix used both to build the block and to detect a duplicate. */
export const HINT_TAG = `<skill_hint source="${HINT_SOURCE}" note="${HINT_NOTE}">`;
/** Marker of an already-present hint (idempotency guard, keeps R6 budget). */
export const HINT_MARKER = `<skill_hint source="${HINT_SOURCE}"`;

export const MAX_ITEMS = 2; // R6
export const MAX_BLOCK_CHARS = 1000; // R6
export const BUDGET_MS = 150; // R6
const SEARCH_LIMIT = 10; // candidate pool before the confident + deny/allow filters
const WHY_MAX = 200; // per-entry «зачем» line cap (block stays ≤1000 chars)
const OFF_VALUES = new Set(["off", "0", "false"]);
const LETTERS_RE = /\p{L}/u;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Config lives next to the plugin module (documented in README). */
export const DEFAULT_CONFIG_PATH = path.join(HERE, "skill-router.config.json");

function errMsg(err) {
  return err && err.message ? String(err.message) : String(err);
}

/** `off` / `0` / `false` (case-insensitive, trimmed) disable the hint (R6). */
export function isHintOff(value) {
  return OFF_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/**
 * A debug sink: `options.debug` may be a writer function or a boolean;
 * otherwise `SKILL_ROUTER_DEBUG=1` in the hook's env enables it. Output goes
 * to stderr only — never into the model context.
 */
function makeDebug(options, env) {
  if (typeof options.debug === "function") return options.debug;
  const enabled = options.debug === true || (options.debug === undefined && String(env.SKILL_ROUTER_DEBUG ?? "") === "1");
  if (!enabled) return () => {};
  return (msg) => {
    try {
      process.stderr.write(`[skill-router] ${msg}\n`);
    } catch {
      /* stderr must never break the session */
    }
  };
}

function normalizeAgentList(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/** Shape: { deny: {agent: [pattern]}, allow: {agent: [pattern]} }; junk → defaults. */
export function normalizeConfig(raw) {
  const cfg = { deny: {}, allow: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cfg;
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
 * Load `skill-router.config.json`. A missing file means the default (hint
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

/** One line, no angle brackets, ≤200 chars — safe for the entry line (§7).
 * Brackets are stripped so a third-party description can never fake or break
 * the `<skill_hint>` envelope; whitespace (incl. newlines) collapses to one line. */
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

// A skill name must not break the one-line entry format `- <имя>: ...; ...,
// name=<имя>` (no whitespace, `:`, `;`, `<`, `>`); such skills are skipped.
const SAFE_NAME_RE = /^[^\s:;<>]+$/u;

/**
 * The block, exactly per spec §7 (R1). `items` — [{name, why}], ≤2.
 * Returns "" when there is nothing to hint.
 */
export function buildHintBlock(items) {
  const list = [];
  if (Array.isArray(items)) {
    for (const it of items) {
      if (!it || typeof it.name !== "string" || !SAFE_NAME_RE.test(it.name)) continue;
      const why = sanitizeWhy(it.why);
      if (!why) continue;
      list.push({ name: it.name, why });
      if (list.length >= MAX_ITEMS) break;
    }
  }
  if (list.length === 0) return "";
  const lines = [HINT_TAG];
  for (const it of list) {
    lines.push(`- ${it.name}: ${it.why}; открыть: инструмент skill, name=${it.name}`);
  }
  lines.push("</skill_hint>");
  const block = lines.join("\n");
  if (block.length > MAX_BLOCK_CHARS) return ""; // budget guard (R6)
  return block;
}

/**
 * Create the `context`-hook callback.
 *
 * One factory call = one index cache: `setup()` in skill-router-hint.ts calls
 * it once per opencode process, so the index is built once per process on the
 * first hook invocation and never rebuilt (spec §7).
 *
 * `options` (all optional, used by tests/demo):
 *   env         — environment object (default process.env)
 *   debug       — writer fn | boolean; default: SKILL_ROUTER_DEBUG=1
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
  const config = options.config ?? loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH, debug);
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

  return function contextHint(event) {
    try {
      if (isHintOff(env.SKILL_ROUTER_HINT)) return; // AC7
      if (!event || !Array.isArray(event.system)) return;
      for (const part of event.system) {
        // Already hinted for this request — keep exactly one block (R6 budget).
        if (part && typeof part.text === "string" && part.text.includes(HINT_MARKER)) return;
      }
      const text = lastUserText(event.messages);
      if (!LETTERS_RE.test(text)) return; // no text / no letters → no hint

      const t0 = clock();
      const state = ensureIndex();
      if (!state.ok) return;

      const agent = typeof event.agent === "string" ? event.agent : "";
      const hasAllow = Object.prototype.hasOwnProperty.call(config.allow, agent);
      const allowList = config.allow[agent] ?? [];
      const denyList = config.deny[agent] ?? [];

      const found = query(state.index, text, { limit: SEARCH_LIMIT });
      const items = [];
      for (const hit of found) {
        // v0.3 (owner decision 26.10.2026): search and hint are split — the
        // full result list is no longer gated, so the hint filters it itself
        // and shows ONLY `confident:true` positions (the former ≥min(2, N)
        // coverage rule). No confident position → no block, exactly like an
        // empty result: AC3 binds the hint, `find` returns everything.
        if (!hit || hit.confident !== true) continue;
        if (typeof hit.name !== "string" || !SAFE_NAME_RE.test(hit.name)) continue; // name must fit the entry line
        if (nameMatches(hit.name, denyList)) continue; // R2: deny wins
        if (hasAllow && !nameMatches(hit.name, allowList)) continue; // allow-only agent
        const why = cleanWhy(state.byPath.get(hit.path)?.description);
        if (!why) continue; // description is the only source of «зачем»
        items.push({ name: hit.name, why });
        if (items.length >= MAX_ITEMS) break;
      }
      const block = buildHintBlock(items);
      if (!block) return;

      const elapsed = clock() - t0;
      if (elapsed > BUDGET_MS) {
        debug(`hint dropped: formation took ${elapsed.toFixed(1)} ms > ${BUDGET_MS} ms`);
        return;
      }
      // The only mutation: one text part at the end of `system`. Messages,
      // history, tools and options are untouched; no tool is ever called (R3/R4).
      event.system.push({ type: "text", text: block });
    } catch (err) {
      debug(`hint skipped (fail-open): ${errMsg(err)}`); // R6
    }
  };
}

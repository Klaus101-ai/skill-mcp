// Index and ranking over discovered skills, backed by MiniSearch (BM25+).
// Field weights: name x3, description x2, headings x1, aliases x1 (spec, M1;
// re-chosen in M5 against measure/README.md; aliases added in v0.2 — the
// bilingual bridge rides in a separate field so it never displaces the
// original fields' relative weights).
// Normalization + stemming + the significant-match gate (AC3) live in
// core/text.mjs and are applied identically to documents and queries.
// No network calls, no writes, no AI: the RU↔EN bridge is one static file
// (core/lexicon.ru-en.json), R5.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { STOP_WORDS, processTerm, significantQueryTokens, tokenize } from "./text.mjs";

const WHY_LIMIT = 160;
const WHY_TERMS_LIMIT = 6;
const FIELD_BOOST = { name: 3, description: 2, headings: 1, aliases: 1 };

// ── v0.2 bilingual term bridge ─────────────────────────────────────────────
// Static RU↔EN dictionary: { "русский термин": ["en", ...] }. At INDEX time a
// document whose text contains a dictionary term gets the *other-language*
// equivalents written into a separate indexed field `aliases` (weight 1), so
// a Russian query finds an English-described skill and vice versa. Stemming
// and normalization hit aliases exactly like any other field — they are
// produced by the same tokenize/processTerm pipeline (MiniSearch applies the
// pipeline to every field). Read-only local file; no network, no LLM (R5).
//
// v0.2.1 — weak pairs (the `_weak` key of the same file): seven bilingual
// pairs whose two sides are BOTH ordinary words in the other language
// (письмо↔letter, возврат↔return, подписка↔subscription, дизайн↔design,
// форма↔form, лот↔lot, доверенность↔power). Their aliases are still INDEXED
// and still RANK (they are part of the `aliases` field, weight unchanged) —
// but they never COUNT TOWARD the AC3 coverage rule: a weak alias alone can
// not prove a topic («подписк» via `subscription` + an unrelated «cloud» is
// exactly the B#51 false positive this excludes). Coverage tokens are
// collected per document into `cover` = own-text terms ∪ STRONG alias terms.
const LEXICON_PATH = fileURLToPath(new URL("./lexicon.ru-en.json", import.meta.url));

/** The meta key of the lexicon file holding the weak RU keys (not a pair). */
const WEAK_KEY = "_weak";

let lexiconCache = null;

/**
 * Build (once) stem-keyed lookup: term-stem -> [{ term, weak }].
 * `weak` marks an equivalence produced by one of the `_weak` RU keys —
 * in BOTH directions (RU term -> EN equivalent and EN token -> RU term).
 * If the same (key, value) pair is reachable from a strong key too, the
 * strong source wins: one solid source must not lose coverage to a weak one.
 */
function loadLexicon() {
  if (lexiconCache) return lexiconCache;
  let map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(LEXICON_PATH, "utf8")); // read-only
    const weakKeys = new Set(
      (Array.isArray(raw[WEAK_KEY]) ? raw[WEAK_KEY] : []).filter((k) => typeof k === "string"),
    );
    for (const [ru, ens] of Object.entries(raw)) {
      if (ru === WEAK_KEY) continue; // meta list, not a pair
      if (!Array.isArray(ens)) continue;
      const ruKey = processTerm(ru);
      const weak = weakKeys.has(ru);
      for (const en of ens) {
        if (typeof en !== "string" || !en) continue;
        // RU term -> EN equivalents (a Russian query finds EN-described skills)
        if (ruKey) addUnique(map, ruKey, en.toLowerCase(), weak);
        // symmetry: EN equivalent -> RU term (an English query finds RU-described skills).
        // Service/short tokens of a multi-word equivalent ("of" in "power of
        // attorney") are skipped: they are common English glue words and would
        // stamp the RU term onto every English document that contains them.
        for (const tok of tokenize(en)) {
          const enKey = processTerm(tok);
          if (!enKey || enKey.length < 3 || STOP_WORDS.has(enKey)) continue;
          addUnique(map, enKey, ru.toLowerCase(), weak);
        }
      }
    }
  } catch {
    // a missing/malformed lexicon only disables the bridge — never breaks indexing
    map = new Map();
  }
  lexiconCache = map;
  return map;
}

function addUnique(map, key, value, weak) {
  const list = map.get(key);
  if (!list) {
    map.set(key, [{ term: value, weak }]);
    return;
  }
  const found = list.find((e) => e.term === value);
  if (!found) list.push({ term: value, weak });
  else if (found.weak && !weak) found.weak = false; // a strong source wins
}

/**
 * The `aliases` text for a document: every dictionary equivalent of a term
 * found in `text` (name + description + headings), space-joined. "" when the
 * text shares no dictionary term with the lexicon. Returns both the full
 * string (what gets INDEXED — weak pairs included, they still rank) and the
 * stems of the STRONG equivalents only (what may COUNT as coverage).
 */
function buildAliases(text) {
  const lex = loadLexicon();
  if (lex.size === 0) return { all: "", strong: [] };
  const found = new Set();
  const strong = new Set();
  for (const raw of tokenize(text)) {
    const key = processTerm(raw);
    if (!key) continue;
    const hit = lex.get(key);
    if (!hit) continue;
    for (const e of hit) {
      found.add(e.term);
      if (e.weak) continue; // weak: ranks, but can never prove a topic
      for (const tok of tokenize(e.term)) {
        const stem = processTerm(tok);
        if (stem) strong.add(stem);
      }
    }
  }
  return { all: [...found].join(" "), strong: [...strong] };
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// --- coverage rule (M7; replaces the M5/M6 score floor) ---------------------
// A result is valid only when it COVERS enough of the query's meaningful
// tokens: the number of matched significant tokens (token equality after the
// shared normalization/stemming pipeline) must be >= min(MIN_COVERAGE, N),
// where N = the number of significant query tokens. A token counts as matched
// only when it occurs in the document's `cover` vocabulary (v0.2.1): the
// document's own name/description/headings tokens + its STRONG bilingual
// aliases. Weak pairs (the lexicon's `_weak` list) are indexed and still
// rank, but never prove a topic on their own — the whole point of an
// ambiguous pair («письмо»↔`letter`) is that it is shared with unrelated
// skills.
// The same single rule serves the MCP `find` and the plugin hint (both call
// search()); when no result covers enough, the answer is [] and the MCP tool
// answers {ok:true, items:[], note:"ничего не найдено"}.
//
// Why 2 (rationale in README.md § AC3, "why two tokens"): one lone matched
// word is never proof of the topic — it is exactly how the junk queries got
// their answers («office», «when», a single shared token); two matched tokens
// are the minimal sign that a skill really talks about the request. Queries
// made of 1–2 meaningful tokens are proven by one of them (min(2, N)), so a
// short, precise query is never over-tightened. N = 0 (only stop words and
// short/acronym-less tokens) can be proven by nothing at all → [].
//
// There is deliberately NO score threshold left: scores still RANK the list,
// they no longer VALIDATE it, so nothing is derived from a measured gap on
// set A and no number has to be re-derived when the corpus changes.
const MIN_COVERAGE = 2;

function significantTerms(terms) {
  const out = [];
  for (const raw of terms) {
    const t = String(raw).toLowerCase().trim();
    if (t.length <= 1) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Build a search index from [{name, path, description, bodyHeadings}]. */
export function buildIndex(skills) {
  // tokenize/processTerm come from core/text.mjs and are used by MiniSearch
  // both when indexing these documents and when processing a query string,
  // so documents and queries share one normalization/stemming pipeline.
  const index = new MiniSearch({
    fields: ["name", "description", "headings", "aliases"],
    storeFields: ["name", "path", "description", "headings", "cover"],
    tokenize,
    processTerm,
    bm25: { k: 1.2, b: 0.7 },
  });
  const docs = skills.map((s, i) => {
    const text = [s.name, s.description || "", (s.bodyHeadings || []).join(" ")].join(" ");
    // v0.2 bilingual bridge: RU↔EN dictionary equivalents of the document's
    // own terms, one static file, weight 1 (core/lexicon.ru-en.json).
    const aliases = buildAliases(text);
    // v0.2.1 coverage vocabulary (AC3): every term of the document's OWN text
    // plus the stems of its STRONG aliases. Weak aliases are deliberately
    // absent — they are indexed in `aliases` (and still rank) but can never
    // count as one of the ≥ min(2, N) meaningful matches.
    const cover = new Set();
    for (const raw of tokenize(text)) {
      const t = processTerm(raw);
      if (t) cover.add(t);
    }
    for (const t of aliases.strong) cover.add(t);
    return {
      id: s.path || `skill-${i}`,
      name: s.name,
      path: s.path,
      description: s.description || "",
      headings: Array.isArray(s.bodyHeadings) ? s.bodyHeadings.join(" ") : "",
      aliases: aliases.all,
      cover: [...cover],
    };
  });
  index.addAll(docs);
  return index;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameMatches(name, pattern) {
  const lower = String(name).toLowerCase();
  if (pattern.includes("*")) {
    const rx = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`, "i");
    return rx.test(name);
  }
  return lower === String(pattern).toLowerCase();
}

function makeFilter(restrictTo) {
  return (result) => restrictTo.some((p) => nameMatches(result.name, p));
}

function buildWhy(result) {
  const terms = significantTerms(result.terms || []).slice(0, WHY_TERMS_LIMIT);
  // Field attribution is TOKEN-level (M6), never `text.includes(term)`: a
  // matched term counts for a field only when that field really contains a
  // word that normalizes/stems to it (otherwise «office» would be credited to
  // the name «Officer-training», which holds it only as a substring). The
  // scan stops at the first word that proves the field, keeping `why`
  // formation inside the latency budget.
  const wanted = new Set(terms);
  const fieldHolds = (text) => {
    if (wanted.size === 0) return false;
    for (const raw of tokenize(text)) {
      const term = processTerm(raw);
      if (term !== null && wanted.has(term)) return true;
    }
    return false;
  };
  const haystacks = [
    ["name", String(result.name || "")],
    ["description", String(result.description || "")],
    ["headings", String(result.headings || "")],
  ];
  const fields = haystacks.filter(([, text]) => fieldHolds(text)).map(([field]) => field);
  let why;
  if (terms.length > 0) {
    why = fields.length
      ? `matched ${fields.join("+")}: ${terms.join(", ")}`
      : `matched keywords: ${terms.join(", ")}`;
  } else {
    // Every matched term was a stop word or a single character.
    why = "matched keywords";
  }
  why = why.replace(/\s+/g, " ").trim();
  if (why.length > WHY_LIMIT) why = `${why.slice(0, WHY_LIMIT - 3)}...`;
  return why;
}

function compareResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

// Winner rule shared by search dedup and by outline/read-section skill
// selection: highest score first; a missing/NaN score counts as -Infinity;
// ties are broken by the lexicographically smaller path.
function compareByScoreThenPath(a, b) {
  const sa = Number.isFinite(a && a.score) ? a.score : -Infinity;
  const sb = Number.isFinite(b && b.score) ? b.score : -Infinity;
  if (sa !== sb) return sb - sa;
  const pa = String((a && a.path) || "");
  const pb = String((b && b.path) || "");
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return 0;
}

/**
 * Deduplicate results that share a skill name: the entry with the highest
 * score wins (lexicographically smaller path on equal scores). The winner is
 * reported at the first position where that name occurred; the relative
 * order of the other names is preserved.
 */
export function dedupeByName(results) {
  const best = new Map();
  for (const r of results) {
    const prev = best.get(r.name);
    if (prev === undefined || compareByScoreThenPath(r, prev) < 0) best.set(r.name, r);
  }
  const emitted = new Set();
  const out = [];
  for (const r of results) {
    if (emitted.has(r.name)) continue;
    emitted.add(r.name);
    out.push(best.get(r.name));
  }
  return out;
}

/**
 * Pick the single skill from a candidate list using the same rule: highest
 * search score when scores are present, otherwise the lexicographically
 * first path. Returns null for an empty/invalid list.
 */
export function selectWinner(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i += 1) {
    if (compareByScoreThenPath(candidates[i], best) < 0) best = candidates[i];
  }
  return best;
}

/**
 * Search the index. Returns [{name, path, score, why}] ordered by score
 * descending (ties broken deterministically by name, then path), with
 * duplicate skill names collapsed to their best-scoring entry.
 * Empty / whitespace-only / punctuation-only queries return [].
 *
 * AC3 coverage gate (M5 gate, M6 token-level match, M7 coverage rule,
 * v0.2.1 weak pairs): the query first yields its meaningful tokens
 * (>= 3 chars or a whitelisted upper-case acronym, not stop words,
 * normalized + stemmed — core/text.mjs). If there are none, the answer is [].
 * Otherwise a result document is kept only when its `cover` vocabulary holds
 * at least `min(MIN_COVERAGE, N)` of those tokens by EQUALITY (same
 * normalization/stemming — never a substring of a longer word; a dot keeps
 * words together, a hyphen splits them). `cover` is built at index time from
 * name/description/headings plus the document's STRONG dictionary aliases;
 * weak aliases (lexicon `_weak`) rank but never cover — MiniSearch's
 * `r.match` alone would count them, so it is no longer the gate's source.
 * Scores rank the surviving list but never validate it — there is no score
 * threshold (M7 removed MIN_STRENGTH together with corpusCeiling). This one
 * rule is the whole AC3 story for every consumer: the MCP `find`
 * (note "ничего не найдено") and the plugin hint (no block) both simply call
 * `search()` and show nothing on [].
 *
 * `boost` optionally overrides the field weights (used by measure/weights.mjs
 * to compare weight candidates on the A set without editing this file).
 */
export function search(index, query, { limit = 5, restrict_to: restrictTo, boost } = {}) {
  if (typeof query !== "string") return [];
  const q = query.trim();
  if (!q) return [];
  if (!/[\p{L}\p{N}]/u.test(q)) return []; // punctuation-only garbage (AC3)

  const sig = significantQueryTokens(q);
  if (sig.length === 0) return []; // nothing meaningful could prove a match (AC3)

  const options = { boost: boost ? { ...boost } : { ...FIELD_BOOST } };
  if (Array.isArray(restrictTo) && restrictTo.length > 0) {
    options.filter = makeFilter(restrictTo);
  }

  const matched = index.search(q, options);
  // Coverage rule (M7, v0.2.1): a result is valid only if at least
  // min(2, N) of the query's meaningful tokens occur in its `cover`
  // vocabulary (own text + STRONG aliases) by token equality after stemming.
  // One shared token proves nothing; a 1–2-token query needs one. Weak
  // aliases never count here; a document stored without `cover` (not built
  // by buildIndex) keeps the pre-v0.2.1 r.match behaviour.
  const need = Math.min(MIN_COVERAGE, sig.length);
  const gated = matched.filter((r) => {
    const cover = Array.isArray(r.cover) ? new Set(r.cover) : null;
    const match = r.match || null;
    if (!cover && !match) return false;
    let count = 0;
    for (const t of sig) {
      const hit = cover ? cover.has(t) : hasOwn(match, t);
      if (hit) count += 1;
      if (count >= need) return true; // enough coverage, no need to scan on
    }
    return false;
  });
  gated.sort(compareResults);
  const unique = dedupeByName(gated);

  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), unique.length) : unique.length;

  return unique.slice(0, capped).map((r) => ({
    name: r.name,
    path: r.path,
    score: r.score,
    why: buildWhy(r),
  }));
}

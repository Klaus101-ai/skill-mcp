// Index and ranking over discovered skills, backed by MiniSearch (BM25+).
// Field weights: name x3, description x2, headings x1 (spec, M1; re-chosen
// in M5 against measure/README.md, the value below is the selected winner).
// Normalization + stemming + the significant-match gate (AC3) live in
// core/text.mjs and are applied identically to documents and queries.
// No network calls, no writes: R5.
import MiniSearch from "minisearch";
import { STOP_WORDS, processTerm, significantQueryTokens, tokenize } from "./text.mjs";

const WHY_LIMIT = 160;
const WHY_TERMS_LIMIT = 6;
const FIELD_BOOST = { name: 3, description: 2, headings: 1 };

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// --- coverage rule (M7; replaces the M5/M6 score floor) ---------------------
// A result is valid only when it COVERS enough of the query's meaningful
// tokens: the number of matched significant tokens (token equality after the
// shared normalization/stemming pipeline — MiniSearch `r.match` keys) must be
// >= min(MIN_COVERAGE, N), where N = the number of significant query tokens.
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
    fields: ["name", "description", "headings"],
    storeFields: ["name", "path", "description", "headings"],
    tokenize,
    processTerm,
    bm25: { k: 1.2, b: 0.7 },
  });
  const docs = skills.map((s, i) => ({
    id: s.path || `skill-${i}`,
    name: s.name,
    path: s.path,
    description: s.description || "",
    headings: Array.isArray(s.bodyHeadings) ? s.bodyHeadings.join(" ") : "",
  }));
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
 * AC3 coverage gate (M5 gate, M6 token-level match, M7 coverage rule): the
 * query first yields its meaningful tokens (>= 3 chars or a whitelisted
 * upper-case acronym, not stop words, normalized + stemmed — core/text.mjs).
 * If there are none, the answer is []. Otherwise a result document is kept
 * only when it contains at least `min(MIN_COVERAGE, N)` of those tokens by
 * EQUALITY (same normalization/stemming — never a substring of a longer word;
 * a dot keeps words together, a hyphen splits them) in
 * name/description/headings. MiniSearch's `r.match` lists the document terms
 * that matched this query, already normalized/stemmed by the very same
 * pipeline, so the containment check is exact and needs no second index.
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
  // Coverage rule (M7): a result is valid only if it covers at least
  // min(2, N) of the query's meaningful tokens (token equality after
  // stemming). One shared token proves nothing; a 1–2-token query needs one.
  const need = Math.min(MIN_COVERAGE, sig.length);
  const gated = matched.filter((r) => {
    const m = r.match;
    if (!m) return false;
    let count = 0;
    for (const t of sig) {
      if (hasOwn(m, t)) count += 1;
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

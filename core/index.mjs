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

// --- relative noise floor (M5, item 4) -------------------------------------
// A result list survives only when its BEST score reaches MIN_STRENGTH of the
// corpus ceiling for this query. The ceiling is, per meaningful query token,
// the best score that token achieves anywhere in the corpus (a one-term
// search, quality multiplier = 1), plus a theoretical BM25 upper bound for a
// token that occurs in NO skill: idf at df = 0, saturation (d + k + 1) and the
// largest field boost of the current weight set. The theoretical part keeps a
// query whose rare tokens are absent from the corpus from getting a tiny
// denominator for free.
//
// MIN_STRENGTH = 0.7 sits inside the measured gap of the A set
// (measure/README.md § Threshold): the biggest empty-query leftover scores
// 0.664 of its ceiling, the weakest of all 50 qrel queries scores 0.720 —
// so 0.7 cuts the leftovers and provably touches no easy/hard query on A.
const MIN_STRENGTH = 0.7;
const BM25_SATURATION = 0.5 + 1.2 + 1; // d + (k + 1) with k=1.2, b irrelevant at tf -> inf

function corpusCeiling(index, sig, boost) {
  // public getter in minisearch 7.x (`get documentCount()`)
  const docs = Number.isFinite(index.documentCount) ? index.documentCount : 0;
  const idfAtZeroDf = Math.log(1 + (docs + 0.5) / 0.5);
  const maxBoost = Math.max(1, ...Object.values(boost));
  const absentTokenBound = idfAtZeroDf * BM25_SATURATION * maxBoost;
  let sum = 0;
  for (const t of sig) {
    const best = index.search(t, { boost }); // one-term query: pure contribution
    sum += best.length > 0 ? best[0].score : absentTokenBound;
  }
  return sum;
}

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
  const haystacks = [
    ["name", String(result.name || "")],
    ["description", String(result.description || "")],
    ["headings", String(result.headings || "")],
  ];
  const fields = haystacks
    .filter(([, text]) => {
      const hay = text.toLowerCase();
      return terms.some((t) => hay.includes(t));
    })
    .map(([field]) => field);
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
 * AC3 significant-match gate (M5): the query first yields its meaningful
 * tokens (>= 3 chars, not stop words, normalized + stemmed — core/text.mjs).
 * If there are none, or if no result document actually contains at least one
 * of them in name/description/headings, the answer is []. MiniSearch's
 * `r.match` lists the document terms that matched this query, already
 * normalized/stemmed by the very same pipeline, so the containment check is
 * exact and needs no second index. This one gate is the whole AC3 story for
 * every consumer: the MCP `find` (note "ничего не найдено") and the plugin
 * hint (no block) both simply call `search()` and show nothing on [].
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
  // AC3 gate: keep a result only if at least one meaningful query token
  // (stemmed) really occurs in this skill's indexed text.
  const gated = matched.filter((r) => {
    const m = r.match;
    if (!m) return false;
    return sig.some((t) => hasOwn(m, t));
  });
  gated.sort(compareResults);
  const unique = dedupeByName(gated);

  // Relative noise floor (M5 item 4): a weak best score against the corpus
  // ceiling means the "match" is noise — answer as if nothing was found.
  if (unique.length > 0) {
    const ceiling = corpusCeiling(index, sig, options.boost);
    if (ceiling > 0 && unique[0].score < MIN_STRENGTH * ceiling) return [];
  }

  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), unique.length) : unique.length;

  return unique.slice(0, capped).map((r) => ({
    name: r.name,
    path: r.path,
    score: r.score,
    why: buildWhy(r),
  }));
}

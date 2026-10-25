// Index and ranking over discovered skills, backed by MiniSearch (BM25+).
// Field weights: name x3, description x2, headings x1 (spec, M1).
// No network calls, no writes: R5.
import MiniSearch from "minisearch";

const WHY_LIMIT = 160;
const WHY_TERMS_LIMIT = 6;
const FIELD_BOOST = { name: 3, description: 2, headings: 1 };

// Stop words (short ru+en list) and single-character tokens are dropped from
// `why`, so only significant terms are shown, at most 6 of them.
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
  "и", "в", "во", "на", "по", "с", "со", "к", "о", "об", "от", "до", "за", "из", "не",
]);

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
  const index = new MiniSearch({
    fields: ["name", "description", "headings"],
    storeFields: ["name", "path", "description", "headings"],
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
 */
export function search(index, query, { limit = 5, restrict_to: restrictTo } = {}) {
  if (typeof query !== "string") return [];
  const q = query.trim();
  if (!q) return [];
  if (!/[\p{L}\p{N}]/u.test(q)) return []; // punctuation-only garbage (AC3)

  const options = { boost: { ...FIELD_BOOST } };
  if (Array.isArray(restrictTo) && restrictTo.length > 0) {
    options.filter = makeFilter(restrictTo);
  }

  const results = index.search(q, options);
  results.sort(compareResults);
  const unique = dedupeByName(results);
  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), unique.length) : unique.length;

  return unique.slice(0, capped).map((r) => ({
    name: r.name,
    path: r.path,
    score: r.score,
    why: buildWhy(r),
  }));
}

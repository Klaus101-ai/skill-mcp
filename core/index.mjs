// Index and ranking over discovered skills, backed by MiniSearch (BM25+).
// Field weights: name x3, description x2, headings x1 (spec, M1).
// No network calls, no writes: R5.
import MiniSearch from "minisearch";

const WHY_LIMIT = 160;
const FIELD_BOOST = { name: 3, description: 2, headings: 1 };

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
  const terms = (result.terms || []).map((t) => String(t).toLowerCase());
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
  let why = fields.length
    ? `matched ${fields.join("+")}: ${terms.slice(0, 6).join(", ")}`
    : `matched keywords: ${terms.slice(0, 6).join(", ")}`;
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

/**
 * Search the index. Returns [{name, path, score, why}] ordered by score
 * descending (ties broken deterministically by name, then path).
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
  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), results.length) : results.length;

  return results.slice(0, capped).map((r) => ({
    name: r.name,
    path: r.path,
    score: r.score,
    why: buildWhy(r),
  }));
}

// Index and ranking over discovered skills, backed by MiniSearch (BM25+).
// Field weights: name x3, description x2, headings x1 (spec, M1; re-chosen
// in M5 against measure/README.md, the value below is the selected winner).
// Normalization + stemming + the significant-match gate (AC3) live in
// core/text.mjs and are applied identically to documents and queries.
// M9 (README § M9): coverage counts only corpus-RARE query tokens and accepts
// one typo for tokens >= 6 chars — both implemented below, no weights /
// stemmer / tokenization change.
// No network calls, no writes: R5.
import MiniSearch from "minisearch";
import { STOP_WORDS, processTerm, significantQueryTokens, tokenize, withinOneEdit } from "./text.mjs";

const WHY_LIMIT = 160;
const WHY_TERMS_LIMIT = 6;
const FIELD_BOOST = { name: 3, description: 2, headings: 1 };

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// --- coverage rule (M7; replaces the M5/M6 score floor) ---------------------
// A result is valid only when it COVERS enough of the query's meaningful
// tokens: the number of matched significant tokens (token equality after the
// shared normalization/stemming pipeline — MiniSearch `r.match` keys) must be
// >= min(MIN_COVERAGE, N), where N = the number of significant query tokens.
// M9 narrows N to the INFORMATIVE (rare in the corpus) tokens and adds one
// typo (distance <= 1) to what "matched" means — see the M9 block below.
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

// --- M9: informative tokens (IDF-lite) + typo tolerance ----------------------
// Two additions to the coverage rule, both stated as corpus facts, not tuned
// to any query id:
//
// 1) INFORMATIVENESS. A query token only COUNTS toward coverage when it is
//    rare in the corpus: document frequency <= 8% of the skills
//    (RARE_DF_RATIO; on the 365-skill corpus floor(0.08 x 365) = 29
//    documents — see measure/README.md § M9 for the df distribution behind
//    that share). df counts the indexed corpus (name + description +
//    headings): the same text search matches, so a rare term really narrows
//    the searchable skills («работы» — 19 searchable texts, not 68 bodies).
//    The whole-SKILL.md reading was measured on set A and rejected (recall
//    0.3600 vs baseline 0.7000); README § M9 records both numbers.
//    Common words («документы», «данные», «работы») still enter the BM25
//    query and therefore still RANK the list, they just cannot PROVE it.
//    need = min(MIN_COVERAGE, N_informative); a query with
//    no informative token at all returns [] (the MCP `find` then answers its
//    standard {items:[], note:"ничего не найдено"}).
//    Small corpora: 8% of fewer than 38 skills is under 3 documents, so the
//    threshold is floored at MIN_RARE_DF = 3 documents — otherwise every
//    shared word in a fixture-scale corpus would count as "common" and no
//    query could ever cover 2 tokens. On the real corpus the floor is inert
//    (3 < 29).
//
// 2) TYPO TOLERANCE. A query token of length >= MIN_TYPO_TOKEN_LENGTH may
//    also match a document term at Levenshtein distance <= 1 (one edit, see
//    core/text.mjs withinOneEdit). Candidates come from a length+first-letter
//    index over the corpus terms (neighbouring lengths len-1/len/len+1 only),
//    so the check never scans the whole corpus: O(sum of 3 small buckets)
//    instead of O(vocabulary x query). The match counts for coverage and is
//    shown in `why` prefixed with "≈". Shorter tokens (< 6) match exactly
//    only — «сайта» (5) never becomes «сайт» through this path.
export const RARE_DF_RATIO = 0.08;
export const MIN_RARE_DF = 3;
export const MIN_TYPO_TOKEN_LENGTH = 6;

/** Max document frequency (in skills) that still counts as "rare". */
export function rareDfMax(corpusSize) {
  return Math.max(MIN_RARE_DF, Math.floor(RARE_DF_RATIO * corpusSize));
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

  // M9 corpus statistics, built from the SAME tokenization/stemming MiniSearch
  // applies, keyed by the same document id (= path) the results carry:
  //   df       — term -> number of skills containing it (informativeness);
  //   docTerms — docId -> Set(term) (typo coverage per result);
  //   buckets  — first letter -> length -> Set(term) (typo candidate lookup;
  //              only neighbouring lengths are ever consulted, see nearTerms).
  //
  // SCOPE of df = the indexed text (name + description + headings) — the same
  // corpus the index searches and coverage matches against. A term's df must
  // be calibrated to what a match can actually be: «работы» occurs in 68
  // SKILL.md bodies but in only 19 searchable texts, and a query for it
  // really does narrow to those 19 skills. The alternative scope (df over the
  // whole SKILL.md) was measured on set A — 0.3600 recall@5 vs baseline
  // 0.7000 (AC2 fails) — and is recorded in measure/README.md § M9 as the
  // rejected reading, not hidden.
  const meta = {
    docCount: docs.length,
    df: new Map(),
    docTerms: new Map(),
    buckets: new Map(),
  };
  for (const doc of docs) {
    const terms = new Set();
    for (const field of ["name", "description", "headings"]) {
      for (const raw of tokenize(doc[field])) {
        const term = processTerm(raw);
        if (term !== null) terms.add(term);
      }
    }
    meta.docTerms.set(doc.id, terms);
    for (const term of terms) {
      meta.df.set(term, (meta.df.get(term) || 0) + 1);
      const letter = term[0];
      let byLen = meta.buckets.get(letter);
      if (!byLen) {
        byLen = new Map();
        meta.buckets.set(letter, byLen);
      }
      let bucket = byLen.get(term.length);
      if (!bucket) {
        bucket = new Set();
        byLen.set(term.length, bucket);
      }
      bucket.add(term);
    }
  }
  index.skillRouterMeta = meta;
  return index;
}

/**
 * Corpus terms at Levenshtein distance <= 1 from `token` (M9). Returns []
 * for tokens shorter than MIN_TYPO_TOKEN_LENGTH (typo tolerance is opt-in by
 * length) and consults only the same-first-letter buckets of lengths
 * len-1/len/len+1, so the cost is a handful of buckets, never the vocabulary.
 */
export function nearTerms(meta, token) {
  if (!meta || token.length < MIN_TYPO_TOKEN_LENGTH) return [];
  const byLen = meta.buckets.get(token[0]);
  if (!byLen) return [];
  const out = [];
  for (const len of [token.length - 1, token.length, token.length + 1]) {
    if (len < 1) continue;
    const bucket = byLen.get(len);
    if (!bucket) continue;
    for (const term of bucket) {
      if (term !== token && withinOneEdit(token, term)) out.push(term);
    }
  }
  return out;
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

function buildWhy(result, fuzzyTerms) {
  // M9: terms matched through typo tolerance are the same real words of the
  // document, so they stay in `why` — but prefixed with "≈" so the line never
  // claims an exact token match. A term that is BOTH an exact match of one
  // query token and a near match of another stays plain (exact wins).
  const fuzzy = new Set(Array.isArray(fuzzyTerms) ? fuzzyTerms : []);
  const exactTerms = significantTerms(result.terms || []).filter((t) => !fuzzy.has(t));
  const nearList = significantTerms([...fuzzy]);
  const terms = [...exactTerms, ...nearList].slice(0, WHY_TERMS_LIMIT);
  const shown = terms.map((t) => (fuzzy.has(t) ? `≈${t}` : t));
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
      ? `matched ${fields.join("+")}: ${shown.join(", ")}`
      : `matched keywords: ${shown.join(", ")}`;
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
 * M9 informative tokens + typo tolerance): the query first yields its
 * meaningful tokens (>= 3 chars or a whitelisted upper-case acronym, not stop
 * words, normalized + stemmed — core/text.mjs). If there are none, the answer
 * is []. M9 then splits them by document frequency: only tokens with
 * df <= rareDfMax(corpus) — RARE in this corpus, ~29 of 365 skills — may prove
 * a match; a query with no such token answers [] (N_informative = 0). A result
 * is kept only when it holds at least `min(MIN_COVERAGE, N_informative)` of
 * the informative tokens in name/description/headings, either by EQUALITY
 * (same normalization/stemming — never a substring of a longer word; a dot
 * keeps words together, a hyphen splits them) or, for tokens of length >= 6,
 * by ONE typo (Levenshtein <= 1 against a length+first-letter bucket of the
 * corpus, the "≈" match). Common tokens still enter the BM25 query, so they
 * still rank — they just no longer validate.
 *
 * Retrieval is two-phase and both phases keep MiniSearch's own scoring:
 * phase 1 is the unchanged M7 query over the original string (scores on set A
 * are byte-identical to M7), phase 2 adds a second MiniSearch query over the
 * near terms found for the informative tokens, so a document reachable only
 * through a typo («налогобложения» -> «налогообложения») still becomes a
 * candidate. A document found by both phases keeps its phase-1 result.
 * Coverage is then computed per candidate from the corpus term sets, and
 * `why` marks the ≈-matched terms.
 *
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

  const meta = index.skillRouterMeta || null;

  // M9: for every significant token — its typo candidates and its effective
  // document frequency (the exact df when the token occurs in the corpus;
  // for an unseen (misspelled) token the df of its closest corpus match, so a
  // typo of a common word does not become "rare" through the typo itself).
  const tokens = sig.map((term) => {
    const near = nearTerms(meta, term);
    let df = 0;
    if (meta) {
      if (meta.df.has(term)) df = meta.df.get(term);
      else if (near.length > 0) {
        let min = Infinity;
        for (const n of near) {
          const d = meta.df.get(n) || 0;
          if (d < min) min = d;
        }
        df = min === Infinity ? 0 : min;
      }
    }
    return { term, near, df, rare: !meta || df <= rareDfMax(meta.docCount) };
  });

  const informative = tokens.filter((t) => t.rare);
  if (informative.length === 0) {
    // M9: no rare token in the query -> nothing can prove a topic -> [].
    return [];
  }
  const need = Math.min(MIN_COVERAGE, informative.length);

  // Phase 1: the original query — same call and same scores as M7.
  const matched = index.search(q, options);

  // Phase 2: typo expansion (informative tokens only — a candidate that
  // survives must cover >= 1 informative token, so this is complete).
  const nearQuery = [];
  const seenNear = new Set();
  for (const t of informative) {
    for (const n of t.near) {
      if (!seenNear.has(n)) {
        seenNear.add(n);
        nearQuery.push(n);
      }
    }
  }
  const byId = new Map();
  for (const r of matched) byId.set(r.id, r);
  if (nearQuery.length > 0) {
    for (const r of index.search(nearQuery.join(" "), options)) {
      if (!byId.has(r.id)) byId.set(r.id, r); // phase-1 result wins on overlap
    }
  }

  // Coverage (M7 rule over M9-informative tokens, equality OR <= 1 typo).
  const gated = [];
  for (const r of byId.values()) {
    const docTerms = meta ? meta.docTerms.get(r.id) : null;
    let count = 0;
    const fuzzyTerms = [];
    const fuzzySeen = new Set();
    if (docTerms) {
      for (const t of tokens) {
        if (docTerms.has(t.term)) {
          if (t.rare) count += 1;
          continue;
        }
        let hit = false;
        for (const n of t.near) {
          if (!docTerms.has(n)) continue;
          hit = true;
          if (!fuzzySeen.has(n)) {
            fuzzySeen.add(n);
            fuzzyTerms.push(n);
          }
        }
        if (hit && t.rare) count += 1;
      }
    } else {
      // Fallback (index not built by buildIndex): M7 behaviour, exact match
      // against MiniSearch's own `match` keys, no typo tolerance.
      const m = r.match;
      if (!m) continue;
      for (const t of sig) {
        if (hasOwn(m, t)) count += 1;
        if (count >= need) break;
      }
    }
    if (count < need) continue;
    gated.push({ ...r, _fuzzy: fuzzyTerms });
  }
  gated.sort(compareResults);
  const unique = dedupeByName(gated);

  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), unique.length) : unique.length;

  return unique.slice(0, capped).map((r) => ({
    name: r.name,
    path: r.path,
    score: r.score,
    why: buildWhy(r, r._fuzzy),
  }));
}

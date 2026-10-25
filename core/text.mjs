// core/text.mjs — tokenization, normalization and light stemming shared by
// index construction, query processing and the significant-match gate (AC3).
//
// WHY one module: a term must be stemmed the SAME way on both sides — a
// query stemmed but an index not (or vice versa) never matches. The pipeline
// is injected into MiniSearch as `tokenize` + `processTerm`; MiniSearch uses
// those options for documents at index time (MiniSearch.ts addFields ->
// tokenize/processTerm) AND for query strings at search time (executeQuery:
// `this._options.tokenize(query).flatMap(processTerm)`), so one definition
// covers both call sites with no second code path to drift.
//
// Pipeline: split -> lowercase -> ё->е -> strip punctuation -> cut endings.
// No dependencies, no network: R5.
//
// Significance (the AC3 gate) is a QUERY-side notion: a token counts as
// meaningful only if its normalized form is >= 3 chars and is not a stop
// word; punctuation-only tokens cannot exist after tokenization. The gate
// keeps a result only when at least one such token of the query (after
// normalization/stemming) really occurs in the skill text.

/** Minimum length of a *meaningful* query token (spec M5, AC3 gate). */
export const MIN_TOKEN_LENGTH = 3;
/** Minimum length of a stem; cuts that would leave a shorter root are refused. */
export const MIN_STEM_LENGTH = 3;
/** Safety valve: suffix cuts are chained until stable, but never endlessly. */
const MAX_STEM_PASSES = 4;

// Stop words (short ru+en list) — used by the `why` line (only significant
// terms are shown) and by the AC3 gate (stop words never prove a match).
export const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
  "и", "в", "во", "на", "по", "с", "со", "к", "о", "об", "от", "до", "за", "из", "не",
]);

// Endings cut by the stemmer (spec M5): RU common case/person/number endings,
// EN -s/-es/-ing/-ed. Sorted longest first, then lexicographically, so the
// choice is deterministic and the longest applicable ending wins ("boxes" ->
// "box", not "boxe").
const RU_SUFFIXES = [
  "ами", "ями",
  "ов", "ев", "ий", "ый", "ая", "ое", "ые", "ой", "ей", "ам", "ям", "ах", "ях",
  "и", "ы", "а", "я", "о", "е", "у", "ю",
].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
const EN_SUFFIXES = ["ing", "es", "ed", "s"]; // longest first: ing(3) > es/ed(2) > s(1)

/**
 * Split text into raw tokens: runs of letters and digits are tokens,
 * everything else (spaces, punctuation, symbols) is a separator. Same rule
 * as the baseline tokenizer (measure/baseline.mjs tokenize), so product and
 * baseline see the same units.
 */
export function tokenize(text) {
  return String(text ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
}

/** lowercase, ё -> е, drop any punctuation/symbol residue ("" for junk). */
export function normalizeTerm(raw) {
  let t = String(raw ?? "").toLowerCase();
  t = t.replace(/ё/g, "е");
  t = t.replace(/[^\p{L}\p{N}]+/gu, "");
  return t;
}

function cutEnding(term, suffixes) {
  for (const suffix of suffixes) {
    if (term.length > suffix.length && term.endsWith(suffix)) {
      const stem = term.slice(0, term.length - suffix.length);
      // Do not chop a root shorter than MIN_STEM_LENGTH: keep trying the
      // next (shorter) ending instead — "uses" -> "use", but "gas" -> "gas".
      if (stem.length >= MIN_STEM_LENGTH) return stem;
    }
  }
  return null;
}

/**
 * Light stemmer: cut frequent RU/EN endings until nothing changes (max 4
 * passes), refusing cuts that leave a root < MIN_STEM_LENGTH. RU and EN
 * endings are disjoint by alphabet (Cyrillic vs Latin letters), so they never
 * interfere. The result is deterministic and applied identically to queries
 * and to indexed documents.
 */
export function stemTerm(term) {
  let current = term;
  for (let pass = 0; pass < MAX_STEM_PASSES; pass += 1) {
    const ru = cutEnding(current, RU_SUFFIXES);
    if (ru) {
      current = ru;
      continue;
    }
    const en = cutEnding(current, EN_SUFFIXES);
    if (en) {
      current = en;
      continue;
    }
    break;
  }
  return current;
}

/**
 * MiniSearch `processTerm`: normalize + stem; empty results are dropped
 * (returned as null, which MiniSearch treats as "do not index/search").
 * Stop words and short tokens are intentionally KEPT in the index and in the
 * BM25 score — they only lose the right to *prove* a match in the gate.
 */
export function processTerm(term) {
  const norm = normalizeTerm(term);
  if (norm === "") return null;
  const stem = stemTerm(norm);
  return stem === "" ? null : stem;
}

/**
 * Meaningful tokens of a query for the AC3 gate, normalized + stemmed,
 * deduplicated, order preserved. A token is meaningful when its normalized
 * form is >= MIN_TOKEN_LENGTH chars and is not a stop word; punctuation-only
 * tokens never survive `tokenize`. Returns [] when nothing meaningful is
 * left — such a query cannot be proven by any skill text and must yield [].
 */
export function significantQueryTokens(text) {
  const seen = new Set();
  const out = [];
  for (const raw of tokenize(text)) {
    const norm = normalizeTerm(raw);
    if (norm.length < MIN_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(norm)) continue;
    const stem = stemTerm(norm);
    if (stem.length < MIN_TOKEN_LENGTH) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

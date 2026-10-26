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
// Pipeline: split into WORDS -> lowercase -> ё->е -> strip punctuation ->
// cut endings. No dependencies, no network: R5.
//
// WORD RULE (M6, token-level match): a word is a run of letters/digits that
// may contain a dot, but never a hyphen. So `next.js` is ONE word (it does
// not hand out a free `next` token to every query containing "next"), while
// `gsap-scrolltrigger` and `AI-документ` are TWO words (a hyphen joins
// independent words — and is the only place where a Latin and a Cyrillic
// word meet in one token). Trailing punctuation is stripped later by
// normalizeTerm, so "договор." and "договор" still fold to one term.
//
// Significance (the AC3 gate) is a QUERY-side notion: a token counts as
// meaningful when its normalized form is >= 3 chars and is not a stop word,
// OR when the token as WRITTEN is a whitelisted uppercase acronym (M6: AI,
// ML, UI …). The gate keeps a result only when at least one such token of
// the query (after normalization/stemming) is EQUAL to a token of the skill
// text — never a substring of a longer word.

/** Minimum length of a *meaningful* query token (spec M5, AC3 gate). */
export const MIN_TOKEN_LENGTH = 3;

/**
 * Whitelist of short tokens that stay meaningful despite being < 3 chars
 * (M6, AC3): common IT acronyms — `ai`, `ml`, `ui`, `ux`, `qa`, `pr`, `hr`,
 * `it`, `ci`, `cd`, `db`, `api`, `sdk`, `gpu`. They are only recognized when
 * the token is WRITTEN in upper case in the query (`AI`, not `ai`): case is
 * the one signal that separates an acronym from an ordinary word — the
 * English pronoun `it` and the lowercase bigrams `in`-class noise must not
 * start proving matches. The 3-char members (`api`, `sdk`, `gpu`) are listed
 * for completeness; they already pass the length rule. Rationale and effect:
 * `measure/README.md` § M6 § Acronyms. RU stop words (`и`, `в`, `с`, `на`)
 * are unaffected — they stay stop words.
 */
export const SHORT_ACRONYMS = new Set([
  "ai", "ml", "ui", "ux", "qa", "pr", "hr", "it", "ci", "cd", "db", "api", "sdk", "gpu",
]);

/**
 * Is `raw` (the token exactly as written in the query) a whitelisted
 * acronym? Letters only (dots/hyphens stripped, so `AI.` counts), 2-3
 * letters, upper case in the source, member of SHORT_ACRONYMS.
 */
export function isShortAcronym(raw) {
  const letters = String(raw ?? "").replace(/[^\p{L}]+/gu, "");
  if (letters.length < 2 || letters.length > 3) return false;
  if (letters !== letters.toUpperCase()) return false; // lower/mixed case = ordinary word
  return SHORT_ACRONYMS.has(letters.toLowerCase());
}
/** Minimum length of a stem; cuts that would leave a shorter root are refused. */
export const MIN_STEM_LENGTH = 3;
/** Safety valve: suffix cuts are chained until stable, but never endlessly. */
const MAX_STEM_PASSES = 4;

// Stop words — the STANDARD list of service/function words (M7): everything
// here is a grammatical or connective word that carries no topic of its own.
// It REPLACES nothing: the short M5/M6 ru+en list is a subset of it, so the
// set only grew (never shrank) when the standard list was applied in M7.
// Subject words are never listed: review, check, audit, policy, contract,
// договор, проверь, аудит, политика and the like stay significant.
// Used by the `why` line (only significant terms are shown) and by the AC3
// coverage gate (stop words never prove a match and never count toward N).
// Every entry is folded through the SAME normalizeTerm the query side uses
// (ё→е, case, punctuation), so membership is exact whatever form is written.
const RAW_STOP_WORDS = [
  // English service words
  "when", "what", "which", "who", "whom", "whose", "why", "how",
  "should", "would", "could", "can", "will", "shall", "may", "might", "must",
  "do", "does", "did", "done", "is", "am", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "there", "here",
  "then", "than", "so", "such", "just", "very", "also", "about",
  "into", "over", "under", "after", "before", "between", "again",
  "more", "most", "some", "any", "all", "no", "not", "only", "own", "same", "too",
  "up", "down", "out", "off",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "she", "it",
  "they", "them", "their", "its",
  "and", "or", "but", "if", "because", "as", "at", "by", "from",
  "in", "of", "on", "to", "with", "without", "next", "new", "using", "use",
  // short English list kept from M5/M6 (a subset check: a, an, the, for …)
  "a", "an", "the", "for",
  // Russian service words (M7 standard list)
  "когда", "что", "какой", "какие", "как", "почему", "зачем", "где", "кто",
  "чтобы", "если", "или", "но", "а", "же", "ли", "бы",
  "для", "при", "без", "под", "над", "про", "через", "между", "после", "перед",
  "также", "уже", "еще", "очень", "только",
  "надо", "нужно", "можно", "есть",
  "был", "была", "было", "были", "будет",
  "этот", "эта", "это", "эти", "тот", "та", "то", "те",
  "мой", "моя", "моё", "мои", "наш", "наша", "наше", "наши",
  "свой", "своя", "свои", "самый",
  // short Russian list kept from M5/M6 (и, в, во, на, по, с, со, к, о, об,
  // от, до, за, из, не) — none of them is in the M7 list above
  "и", "в", "во", "на", "по", "с", "со", "к", "о", "об", "от", "до", "за", "из", "не",
  // v0.2 request verbs (owner-approved 26.10.2026): words that only ASK for
  // an action carry no topic — «запусти посмотри попробуй» must prove nothing.
  // SUBJECT verbs stay significant on purpose: проверь/проверить/проверка,
  // аудит, review (they correlate with the topic and already work).
  // "можно"/"нужно"/"надо"/"бы"/"еще" are already listed above (M7).
  "запустить", "запусти", "запускай",
  "посмотреть", "посмотри", "посмотрим",
  "глянуть", "глянь",
  "попробовать", "попробуй",
  "прогнать", "прогони", "прогоняй",
  "сделать", "сделай",
  "помочь", "помоги",
  "подсказать", "подскажи",
  "показать", "покажи",
  "найти", "найди",
  "можешь", "давай", "плиз", "пожалуйста", "хочу", "хотел",
  "сам", "сама", "само",
];

export const STOP_WORDS = new Set(RAW_STOP_WORDS.map((w) => normalizeTerm(w)));

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
 * Split text into WORDS (M6: token-level match): runs of letters and digits
 * are words, a dot stays INSIDE a word (`next.js` is one word — its parts
 * are not free-standing occurrences of `next`/`js`), everything else
 * (spaces, punctuation, symbols, hyphens) separates words. Tokens with no
 * letter/digit at all (`...`) are dropped. Hyphens stay separators: they
 * join independent words (`gsap-scrolltrigger`, `next-steps`) and are the
 * boundary in mixed-script compounds (`AI-документ`).
 */
export function tokenize(text) {
  return String(text ?? "")
    .split(/[^\p{L}\p{N}.]+/u)
    .filter((t) => t !== "" && /[\p{L}\p{N}]/u.test(t));
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
 * form is >= MIN_TOKEN_LENGTH chars and is not a stop word — or when the
 * token as written is a whitelisted upper-case acronym (M6: `AI`, `ML` …,
 * see SHORT_ACRONYMS); punctuation-only tokens never survive `tokenize`.
 * The stop list (M7, standard service words) governs the ORDINARY usage of a
 * word: the check is skipped for a whitelisted upper-case acronym, because
 * case is exactly what separates `IT` (the acronym, M6) from `it` (the
 * pronoun, a stop word) — lowercase `it` is already < 3 chars and never
 * significant either way.
 * Returns [] when nothing meaningful is left — such a query cannot be
 * proven by any skill text and must yield [].
 */
export function significantQueryTokens(text) {
  const seen = new Set();
  const out = [];
  for (const raw of tokenize(text)) {
    const acronym = isShortAcronym(raw);
    const norm = normalizeTerm(raw);
    if (!acronym && norm.length < MIN_TOKEN_LENGTH) continue;
    if (!acronym && STOP_WORDS.has(norm)) continue;
    const stem = stemTerm(norm);
    if (!acronym && stem.length < MIN_TOKEN_LENGTH) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

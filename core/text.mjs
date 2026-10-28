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
//
// CJK / SE-ASIAN RUNS (multilingual search): Han/Kana/Hangul/Thai/Lao/Khmer/
// Myanmar are written WITHOUT spaces, so the plain split would turn a whole
// phrase into ONE token («做原型») that only matches the same unbroken string —
// and the 3-char threshold would additionally drop two-character words. Each
// such run is cut out and tokenized on its own: word segments from
// Intl.Segmenter (script locale) when the runtime has it, UNION character
// bigrams over the run — the unsegmented run itself is never emitted. Latin
// and Cyrillic keep the ORIGINAL split; `normalizeTerm` keeps CJK (those
// characters are letters). See the CJK section above `tokenize`.

/** Minimum length of a *meaningful* query token (spec M5, AC3 gate).
 * CJK / SE-Asian tokens are EXEMPT from this threshold: a two-character word
 * (网站, 投标) is a whole word and must be able to prove a match; a SINGLE
 * character of those scripts is never meaningful (see significantQueryTokens). */
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

// ── CJK / South-East Asian runs (script-aware segmentation) ────────────────
// Scripts that write words WITHOUT spaces: Han, Hiragana, Katakana, Hangul,
// Thai, Lao, Khmer, Myanmar. One run = one token under the plain split
// («网站» matched only as a whole «网站», «做原型» only as «做原型»), so every
// run is pulled out of the text and tokenized on its own rules:
//
//   word segments from Intl.Segmenter (granularity "word", script locale)
//   UNION character bigrams over the whole run. The union covers both sides
//   of a match: dictionary segments line up when both sides segment the same
//   way (投标, 网站), bigrams line up when they do not («高保真» is segmented
//   «高保»|«真», but its bigrams «高保»/«保真» are stable on both sides).
//   Per-segment bigrams are a SUBSET of the run's bigrams (a segment is a
//   contiguous slice of the run), so emitting run bigrams covers them too.
//   The unsegmented run itself is never emitted as one token — except the
//   degenerate 1–2 character runs, where any bigram rule output IS the run
//   («招商» → its only bigram «招商»; that is what lets a two-character
//   query word exist at all when the dictionary splits it into single
//   characters — on this host: 招商 → «招»|«商»).
//
// Intl.Segmenter missing (small-ICU runtime) → the same bigrams over the run
// are the ENTIRE fallback: the search keeps working, only dictionary precision
// is lost. Locale per run: ja when the run carries Kana, ko for Hangul,
// th/lo/km/my for their own scripts, otherwise zh for a pure-Han run.
// Latin/Cyrillic are untouched: `tokenize` only peels CJK runs off and runs
// the ORIGINAL split over everything else (dot inside a word, hyphen as a
// separator — both unchanged).

/** One character of a runless script (CJK / SE-Asian) — detection only (/g not set: `.test` stays stateless). */
const CJK_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** A greedy run of the same characters (global — used via matchAll). */
const CJK_RUN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;

/** Does `token` contain any CJK / SE-Asian character? */
export function isCjkToken(token) {
  return CJK_CHAR_RE.test(String(token ?? ""));
}

/** locale -> cached Intl.Segmenter, `null` cached for "cannot build one". */
const SEGMENTER_CACHE = new Map();

/** Script locale of a run: Kana wins (Japanese), then Hangul, Thai, Lao, Khmer, Myanmar; a pure-Han run → zh. */
function localeForRun(run) {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run)) return "ja";
  if (/[\p{Script=Hangul}]/u.test(run)) return "ko";
  if (/[\p{Script=Thai}]/u.test(run)) return "th";
  if (/[\p{Script=Lao}]/u.test(run)) return "lo";
  if (/[\p{Script=Khmer}]/u.test(run)) return "km";
  if (/[\p{Script=Myanmar}]/u.test(run)) return "my";
  return "zh";
}

/**
 * Word segments of one run, or null when Intl.Segmenter is unavailable or
 * refuses to build — the caller then falls back to bigrams only. The
 * AVAILABILITY is checked on every call (so a runtime without the segmenter —
 * and the test that unpicks it — never sees a stale cache entry); only the
 * construction itself is cached per locale.
 */
function segmentRun(run) {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  const locale = localeForRun(run);
  let segmenter = SEGMENTER_CACHE.get(locale);
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    } catch {
      segmenter = null;
    }
    SEGMENTER_CACHE.set(locale, segmenter);
  }
  if (segmenter === null) return null;
  try {
    const parts = [];
    for (const { segment } of segmenter.segment(run)) {
      if (segment !== "") parts.push(segment);
    }
    return parts;
  } catch {
    return null; // a segmenting failure must degrade to bigrams, never throw
  }
}

/**
 * Tokenize one CJK/SE-Asian run: dictionary segments (when available) UNION
 * character bigrams over the whole run, deduplicated, order preserved. The
 * raw run is never emitted as a single token.
 */
function emitCjkRun(out, run, seen) {
  const emit = (t) => {
    if (t === "" || seen.has(t)) return; // dedupe: one occurrence per run set
    seen.add(t);
    out.push(t);
  };
  const segments = segmentRun(run);
  if (segments) for (const seg of segments) emit(seg); // the word itself
  if (run.length === 1) {
    emit(run); // a lone character: nothing to pair it with (never significant)
    return;
  }
  for (let i = 0; i + 1 < run.length; i += 1) emit(run.slice(i, i + 2)); // bigrams
}

/** The ORIGINAL split rule over a non-CJK piece: dot inside a word, everything else separates. */
function pushPlainWords(out, piece) {
  if (piece === "") return;
  for (const t of piece.split(/[^\p{L}\p{N}.]+/u)) {
    if (t !== "" && /[\p{L}\p{N}]/u.test(t)) out.push(t);
  }
}

/**
 * Split text into WORDS (M6: token-level match): runs of letters and digits
 * are words, a dot stays INSIDE a word (`next.js` is one word — its parts
 * are not free-standing occurrences of `next`/`js`), everything else
 * (spaces, punctuation, symbols, hyphens) separates words. Tokens with no
 * letter/digit at all (`...`) are dropped. Hyphens stay separators: they
 * join independent words (`gsap-scrolltrigger`, `next-steps`) and are the
 * boundary in mixed-script compounds (`AI-документ`).
 *
 * Script-aware part (multilingual): every Han/Kana/Hangul/Thai/Lao/Khmer/
 * Myanmar run is removed FIRST and expanded into segments + bigrams (see the
 * CJK section above), so `HTML原型` yields `HTML` + the CJK tokens instead of
 * one mixed token, and a space-less CJK phrase yields words. Everything
 * outside those runs goes through the original split unchanged; CJK tokens
 * are deduplicated, Latin/Cyrillic keep their natural multiplicity.
 */
export function tokenize(text) {
  const s = String(text ?? "");
  const out = [];
  const seenCjk = new Set();
  let last = 0;
  for (const m of s.matchAll(CJK_RUN_RE)) {
    pushPlainWords(out, s.slice(last, m.index));
    emitCjkRun(out, m[0], seenCjk);
    last = m.index + m[0].length;
  }
  pushPlainWords(out, s.slice(last));
  return out;
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
 *
 * CJK / SE-Asian exception (multilingual): the MIN_TOKEN_LENGTH = 3 rule does
 * not apply to those tokens — a two-character word (网站, 投标, 原型) is a real
 * word and may prove a match — but a SINGLE character of those scripts is
 * never significant («网» alone proves nothing, exactly like «и»). The stop
 * list and the stemmer still run unchanged; neither can touch a CJK token
 * (RU/EN endings are a different alphabet), so stem === norm there.
 */
export function significantQueryTokens(text) {
  const seen = new Set();
  const out = [];
  for (const raw of tokenize(text)) {
    const acronym = isShortAcronym(raw);
    const norm = normalizeTerm(raw);
    const cjk = isCjkToken(norm);
    if (cjk) {
      // CJK/SE-Asian: exempt from the 3-char threshold, gated on ≥ 2 chars
      // instead — one lone character (网, 作, ส) is not meaningful.
      if (norm.length < 2) continue;
    } else {
      if (!acronym && norm.length < MIN_TOKEN_LENGTH) continue;
    }
    if (!acronym && STOP_WORDS.has(norm)) continue;
    const stem = stemTerm(norm);
    if (!cjk && !acronym && stem.length < MIN_TOKEN_LENGTH) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

// M5 + M6: normalization, light stemming and significant-token extraction
// (core/text.mjs). These three properties back the AC3 gate and the shared
// index/query pipeline: RU cases and EN forms must fold to one term, tokens
// shorter than 3 chars must never be mangled (whitelisted upper-case
// acronyms excepted), and the significance rules (length >= 3 or acronym,
// not a stop word, not punctuation) decide what may prove a match. M6 adds
// the word rule: a dot keeps a word together, a hyphen splits it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  STOP_WORDS,
  MIN_TOKEN_LENGTH,
  tokenize,
  normalizeTerm,
  stemTerm,
  processTerm,
  significantQueryTokens,
  isShortAcronym,
} from "../core/text.mjs";

test("tokenize: letters and digits are tokens, everything else separates", () => {
  assert.deepEqual(tokenize("Договор поставки, №5 — срочно!"), ["Договор", "поставки", "5", "срочно"]);
  assert.deepEqual(tokenize("!!! ... ---"), []);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
});

test("normalizeTerm: lower-case, ё -> е, punctuation stripped", () => {
  assert.equal(normalizeTerm("ДОГОВОР"), "договор");
  assert.equal(normalizeTerm("всё"), "все");
  assert.equal(normalizeTerm("мир!"), "мир");
  assert.equal(normalizeTerm("2026-10"), "202610");
  assert.equal(normalizeTerm("!!!"), "");
});

test("stemmer RU: договора / договор / договоры / договоров fold to one term", () => {
  const forms = ["договор", "договора", "договоры", "договоров", "договоре", "договорами", "договорове"];
  const stems = new Set(forms.map(stemTerm));
  assert.equal(stems.size, 1, `expected one stem, got: ${[...stems].join(", ")}`);
  assert.equal(stemTerm("договора"), "договор");
  assert.equal(stemTerm("статья"), stemTerm("статьи"));
  assert.equal(stemTerm("статьи"), stemTerm("статьями"));
  // chained cuts: предложения -> предложени -> предложен
  assert.equal(stemTerm("предложения"), "предложен");
});

test("stemmer EN: plurals and -ing/-ed forms fold to one term", () => {
  assert.equal(stemTerm("review"), stemTerm("reviews"));
  assert.equal(stemTerm("box"), stemTerm("boxes"));
  assert.equal(stemTerm("index"), stemTerm("indexing"));
  assert.equal(stemTerm("index"), stemTerm("indexed"));
  assert.equal(stemTerm("cat"), stemTerm("cats"));
  assert.equal(stemTerm("use"), stemTerm("uses")); // "-es" guard falls back to "-s"
});

test("stemmer never cuts a root shorter than 3 characters", () => {
  assert.equal(MIN_TOKEN_LENGTH, 3);
  assert.equal(stemTerm("gas"), "gas", "would leave 'ga'");
  assert.equal(stemTerm("для"), "для", "would leave 'дл'");
  assert.equal(stemTerm("ов"), "ов", "2-char token is never cut");
  assert.equal(stemTerm("и"), "и");
  assert.equal(stemTerm("go"), "go");
  assert.equal(stemTerm("по"), "по", "stop words keep their form in the index");
});

test("processTerm: normalize + stem, junk becomes null", () => {
  assert.equal(processTerm("Договора"), "договор");
  assert.equal(processTerm("Всё"), "все");
  assert.equal(processTerm("!!!"), null);
  assert.equal(processTerm(""), null);
});

// ── M6: word rule (dot / hyphen) and the upper-case acronym whitelist ──────

test("M6 word rule: a dot stays inside the word, a hyphen separates words", () => {
  assert.deepEqual(tokenize("Next.js gsap-scrolltrigger"), ["Next.js", "gsap", "scrolltrigger"]);
  assert.deepEqual(tokenize("договор. и т.д."), ["договор.", "и", "т.д."]);
  assert.deepEqual(tokenize("!!! ... ---"), [], "punctuation-only runs are not words");
  // same word either way: trailing punctuation is stripped by normalizeTerm
  assert.equal(normalizeTerm("next.js"), normalizeTerm("Next.js"));
  assert.equal(normalizeTerm("Next.js"), "nextjs");
  // and both sides of the index fold identically (document «next.js», query «next.js»)
  assert.equal(processTerm("Next.js"), processTerm("next.js"));
});

test("M6 acronyms: whitelisted short tokens are significant only in upper case", () => {
  assert.deepEqual(significantQueryTokens("AI"), ["ai"]);
  assert.deepEqual(significantQueryTokens("AI-документ"), ["ai", "документ"]);
  assert.deepEqual(significantQueryTokens("PR HR IT"), ["pr", "hr", "it"]);
  // lower/mixed case = ordinary word, stays insignificant (frozen M5 rule)
  assert.deepEqual(significantQueryTokens("ai go x"), []);
  assert.deepEqual(significantQueryTokens("it is ok"), [], "lowercase «it» is the pronoun");
  // not on the whitelist -> never significant, whatever the case
  assert.deepEqual(significantQueryTokens("GO"), []);
  // RU stop words keep proving nothing
  assert.deepEqual(significantQueryTokens("и в с на"), []);
});

test("M6 isShortAcronym: letters only, 2-3 of them, upper case, whitelisted", () => {
  assert.equal(isShortAcronym("AI"), true);
  assert.equal(isShortAcronym("AI."), true);
  assert.equal(isShortAcronym("IT"), true);
  assert.equal(isShortAcronym("ai"), false, "lower case");
  assert.equal(isShortAcronym("Ai"), false, "mixed case");
  assert.equal(isShortAcronym("A"), false, "1 letter");
  assert.equal(isShortAcronym("NEXT"), false, "4 letters / not whitelisted");
  assert.equal(isShortAcronym("GO"), false, "not whitelisted");
  assert.equal(isShortAcronym("ИИ"), false, "not Latin whitelist");
});

test("significantQueryTokens: length >= 3, not a stop word, stems deduplicated", () => {
  // M7: «как» is a standard service word — it no longer proves anything;
  // «с» (1 char) and the stop words «на/по/во/о» do not either.
  assert.deepEqual(significantQueryTokens("Как сварить борщ с говядиной"), [
    "сварить",
    "борщ",
    "говядин",
  ]);
  assert.deepEqual(significantQueryTokens("на по с во о"), [], "stop words prove nothing");
  assert.deepEqual(significantQueryTokens("ai go x"), [], "below 3 chars prove nothing");
  assert.deepEqual(significantQueryTokens("!!! ???"), [], "punctuation proves nothing");
  assert.deepEqual(significantQueryTokens("договора договор договоры"), ["договор"], "cases fold");
  assert.deepEqual(significantQueryTokens("iPhone15 Pro 123"), ["iphone15", "pro", "123"], "latin/digits ok");
  for (const t of significantQueryTokens("Проверь договор аренды офис")) {
    assert.ok(t.length >= 3, `short significant token: ${t}`);
    assert.ok(!STOP_WORDS.has(t), `stop word as significant token: ${t}`);
  }
});

// ── M7: the standard service-word list ──────────────────────────────────────

// The M7 spec list, verbatim — every member must be a stop word (checked in
// its normalized form, so «моё»/«ещё» match their ё→е spellings).
const M7_STOP_EN = [
  "when", "what", "which", "who", "whom", "whose", "why", "how", "should", "would",
  "could", "can", "will", "shall", "may", "might", "must", "do", "does", "did", "done",
  "is", "am", "are", "was", "were", "be", "been", "being", "this", "that", "these",
  "those", "there", "here", "then", "than", "so", "such", "just", "very", "also",
  "about", "into", "over", "under", "after", "before", "between", "again", "more",
  "most", "some", "any", "all", "no", "not", "only", "own", "same", "too", "up",
  "down", "out", "off", "i", "me", "my", "we", "us", "our", "you", "your", "he",
  "she", "it", "they", "them", "their", "its", "and", "or", "but", "if", "because",
  "as", "at", "by", "from", "in", "of", "on", "to", "with", "without", "next",
  "new", "using", "use",
];
const M7_STOP_RU = [
  "когда", "что", "какой", "какие", "как", "почему", "зачем", "где", "кто", "чтобы",
  "если", "или", "но", "а", "же", "ли", "бы", "для", "при", "без", "под", "над",
  "про", "через", "между", "после", "перед", "также", "уже", "ещё", "очень", "только",
  "надо", "нужно", "можно", "есть", "был", "была", "было", "были", "будет",
  "этот", "эта", "это", "эти", "тот", "та", "то", "те", "мой", "моя", "моё", "мои",
  "наш", "наша", "наше", "наши", "свой", "своя", "свои", "самый",
];

test("M7 stop list: every spec member is a stop word (ru + en)", () => {
  for (const w of M7_STOP_EN) assert.ok(STOP_WORDS.has(w), `EN stop word missing: ${w}`);
  for (const w of M7_STOP_RU) assert.ok(STOP_WORDS.has(normalizeTerm(w)), `RU stop word missing: ${w}`);
  // the M5/M6 short list is a SUBSET — nothing was dropped when M7 expanded it
  for (const w of ["a", "an", "the", "for", "и", "в", "во", "на", "по", "с", "со", "к", "о", "об", "от", "до", "за", "из", "не"]) {
    assert.ok(STOP_WORDS.has(w), `M5/M6 stop word lost in M7: ${w}`);
  }
});

test("M7 stop list: when/what/should count as significant zero, subject words do not", () => {
  // the AC3 junk queries #58/#59 lose their service-word tokens
  assert.deepEqual(significantQueryTokens("When is the next bus to the airport"), ["bus", "airport"]);
  assert.deepEqual(significantQueryTokens("What coffee should I buy for the office"), ["coffee", "buy", "office"]);
  assert.deepEqual(significantQueryTokens("when what should"), [], "service words alone prove nothing");
  assert.deepEqual(significantQueryTokens("why should we do this that"), []);
  assert.deepEqual(significantQueryTokens("когда что какой как почему зачем"), []);
  assert.deepEqual(significantQueryTokens("нужно можно только уже этот"), []);
  // subject words stay significant — the list is service words only
  for (const w of ["review", "check", "audit", "policy", "contract"]) {
    assert.deepEqual(significantQueryTokens(w), [w], `${w} must stay significant`);
  }
  for (const w of ["договор", "проверь", "аудит", "политика"]) {
    assert.equal(significantQueryTokens(w).length, 1, `${w} must stay significant`);
    assert.ok(!STOP_WORDS.has(normalizeTerm(w)), `${w} must not be a stop word`);
  }
});

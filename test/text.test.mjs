// M5: normalization, light stemming and significant-token extraction
// (core/text.mjs). These three properties back the AC3 gate and the shared
// index/query pipeline: RU cases and EN forms must fold to one term, tokens
// shorter than 3 chars must never be mangled, and the significance rules
// (length >= 3, not a stop word, not punctuation) decide what may prove a
// match.
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

test("significantQueryTokens: length >= 3, not a stop word, stems deduplicated", () => {
  // «как» qualifies (3 chars, absent from the frozen stop list) — per spec;
  // «с» (1 char) and «с»-class stop words do not.
  assert.deepEqual(significantQueryTokens("Как сварить борщ с говядиной"), [
    "как",
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

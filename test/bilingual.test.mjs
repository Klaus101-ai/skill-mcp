// v0.2: request-verb stopwords (owner decision 26.10.2026) and the static
// RU↔EN bilingual term bridge (core/lexicon.ru-en.json -> `aliases` field).
// Covers: verbs-only queries prove nothing, a Russian query reaches an
// English-described skill and vice versa, the «проверь договор поставки»
// regression, and the lexicon file's validity (static, no network — R5).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { STOP_WORDS, normalizeTerm, significantQueryTokens } from "../core/text.mjs";
import { buildIndex, search } from "../core/index.mjs";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";

const LEXICON_PATH = fileURLToPath(new URL("../core/lexicon.ru-en.json", import.meta.url));

function skill(name, description) {
  return { name, path: `C:/x/${name}/SKILL.md`, description, bodyHeadings: [] };
}

// ── 1. request verbs are stop words ────────────────────────────────────────

const REQUEST_VERBS = [
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

test("v0.2: every request verb is a stop word", () => {
  for (const w of REQUEST_VERBS) {
    assert.ok(STOP_WORDS.has(normalizeTerm(w)), `request verb not a stop word: ${w}`);
  }
});

test("v0.2: subject verbs are NOT stop words (проверь/аудит/review)", () => {
  for (const w of ["проверь", "проверить", "проверка", "аудит", "review"]) {
    assert.ok(!STOP_WORDS.has(normalizeTerm(w)), `subject word must stay significant: ${w}`);
  }
});

test("v0.2: a query of request verbs alone yields no significant tokens -> no results", () => {
  assert.deepEqual(significantQueryTokens("запусти посмотри попробуй"), []);
  const idx = buildIndex([
    skill("skill-x", "специализированный текст про квантовую физику"),
    skill("skill-y", "рецепты борща и пельменей"),
  ]);
  assert.deepEqual(search(idx, "запусти посмотри попробуй", { limit: 5 }), []);
  // mixed: verbs drop out, the subject word still decides
  assert.deepEqual(significantQueryTokens("посмотри и запусти тесты"), ["тест"]);
});

// ── 2. bilingual bridge RU -> EN and EN -> RU ──────────────────────────────

test("v0.2: RU query «тесты» finds a skill with an ENGLISH description containing 'test'", () => {
  const idx = buildIndex([
    skill("skill-entest", "Run the unit test suite before every release, keep the test fixtures green"),
    skill("skill-rudoc", "инструкция по стирке белья в машинке автомат"),
  ]);
  const results = search(idx, "тесты", { limit: 5 });
  assert.ok(results.length >= 1, "the EN-described skill must be reachable from a RU query");
  assert.equal(results[0].name, "skill-entest");
});

test("v0.2: EN query 'contract' finds a skill with a RUSSIAN description", () => {
  const idx = buildIndex([
    skill("skill-rudog", "разбор договора поставки: сроки, оплата и ответственность сторон"),
    skill("skill-encook", "how to boil eggs and fry potatoes quickly"),
  ]);
  const results = search(idx, "contract", { limit: 5 });
  assert.ok(results.length >= 1, "the RU-described skill must be reachable from an EN query");
  assert.equal(results[0].name, "skill-rudog");
});

test("v0.2: aliases field exists and is indexed with weight 1", () => {
  const idx = buildIndex([skill("skill-dog", "договор поставки")]);
  // EN query reaches the RU doc through the aliases field only
  const results = idx.search("contract");
  assert.ok(results.length >= 1, "raw index must contain the aliases term");
  assert.ok(results[0].match && Object.prototype.hasOwnProperty.call(results[0].match, "contract"));
});

// ── 3. regression + owner message ──────────────────────────────────────────

test("v0.2 regression: «проверь договор поставки» still leads to supply-contract-review", (t) => {
  const { skills } = discoverSkills(defaultRoots());
  const has = skills.some((s) => s.name === "supply-contract-review");
  if (!has) {
    t.skip("supply-contract-review not in the default roots on this host");
    return;
  }
  const idx = buildIndex(skills);
  const results = search(idx, "проверь договор поставки", { limit: 5 });
  assert.ok(results.length >= 1, "the regression query must return results");
  assert.equal(results[0].name, "supply-contract-review");
});

test("v0.2 regression: the owner's request-verb message yields no hint candidates", (t) => {
  const { skills } = discoverSkills(defaultRoots());
  if (skills.length === 0) {
    t.skip("no skill roots on this host");
    return;
  }
  const idx = buildIndex(skills);
  const msg = "Ты можешь сам запустить тесты? Посмотри какие есть скилы. И попробуй их пррогнать";
  // v0.3: search returns the raw list — the message still proves nothing, so
  // every position is confident:false and the hint (confident only) stays off.
  const results = search(idx, msg, { limit: 10 });
  assert.ok(
    results.every((r) => r.confident === false),
    `no position may be confident: ${results.map((r) => `${r.name}:${r.confident}`).join(", ")}`,
  );
});

// ── 4. lexicon validity (static file, R5) ──────────────────────────────────

test("v0.2 lexicon: valid JSON, values are string arrays, keys unique, 150–250 pairs", () => {
  const raw = fs.readFileSync(LEXICON_PATH, "utf8");
  const data = JSON.parse(raw);
  assert.equal(typeof data, "object");
  assert.ok(!Array.isArray(data));
  const keys = Object.keys(data);
  assert.ok(keys.length >= 150 && keys.length <= 250, `pair count out of range: ${keys.length}`);
  // JSON.parse silently overwrites duplicate keys — detect them in the raw text
  const keyLines = [...raw.matchAll(/^\s*"([^"]+)":\s*\[/gm)].map((m) => m[1]);
  assert.equal(keyLines.length, keys.length, "duplicate keys in the lexicon file");
  for (const k of keys) {
    const v = data[k];
    assert.ok(Array.isArray(v), `${k}: value must be an array`);
    assert.ok(v.length >= 1, `${k}: empty equivalent list`);
    for (const e of v) {
      assert.equal(typeof e, "string", `${k}: non-string equivalent ${JSON.stringify(e)}`);
      assert.ok(e.trim() !== "", `${k}: blank equivalent`);
    }
  }
});

// ── 5. v0.2.1 weak pairs: indexed and ranked, but never coverage ───────────

test("v0.2.1 lexicon: exactly seven weak keys, each a real pair, «тест» not among them", () => {
  const raw = JSON.parse(fs.readFileSync(LEXICON_PATH, "utf8"));
  assert.ok(Array.isArray(raw._weak), "_weak must be a flat array of RU keys");
  assert.deepEqual(
    new Set(raw._weak),
    new Set(["письмо", "возврат", "подписка", "дизайн", "форма", "лот", "доверенность"]),
    "_weak must flag exactly the seven ambilateral pairs (both directions)",
  );
  for (const k of raw._weak) {
    assert.ok(Array.isArray(raw[k]), `${k}: weak key must exist as a pair`);
  }
  // the language bridge for «тесты» depends on the `тест` pair staying strong
  assert.ok(!raw._weak.includes("тест") && !raw._weak.includes("тестирование"));
});

test("v0.2.1: a weak alias never counts toward coverage («письмо» via `letter`)", () => {
  // The doc's ONLY tie to «письмо» is the weak pair письмо↔letter; its
  // «договор» (from `contract`) is a strong pair.
  const idx = buildIndex([skill("skill-letter", "contract letter drafting for law firms")]);
  // the weak alias IS still indexed — raw MiniSearch sees «письмо» (it ranks)
  assert.ok(idx.search("письмо").length >= 1, "weak alias must stay in the index");
  // … but it can not help PROVE the topic: 1 of 2 meaningful tokens (только
  // «договор») → the position is returned with confident:false (v0.3) and the
  // hint therefore never shows it.
  const partial = search(idx, "письмо договор", { limit: 5 });
  assert.equal(partial.length, 1, "the raw match is returned (v0.3)");
  assert.equal(partial[0].name, "skill-letter");
  assert.equal(partial[0].confident, false, "a weak alias proves nothing");
  // control: with a strong pair the very same doc is reachable and confident (1 of 1)
  assert.equal(search(idx, "договор", { limit: 5 })[0]?.confident, true, "strong pair must still cover");
  assert.equal(search(idx, "letter", { limit: 5 })[0]?.confident, true, "the EN word itself is own text, not an alias");
});

test("v0.2.1: weak aliases still influence ranking — they only stop proving", () => {
  const idx = buildIndex([
    skill("skill-letters", "supply contract templates and letter drafting"),
    skill("skill-plain", "supply contract templates only"),
  ]);
  // Both docs cover «договор»+«поставка» through STRONG pairs (contract/supply),
  // so both survive the gate (2 of 3). skill-letters additionally carries the
  // weak alias «письмо», which still contributes BM25 weight and ranks it first.
  const results = search(idx, "договор поставка письмо", { limit: 5 });
  assert.deepEqual(results.map((r) => r.name), ["skill-letters", "skill-plain"]);
  assert.ok(
    results[0].score > results[1].score,
    `weak alias must raise the score: ${results[0].score} vs ${results[1].score}`,
  );
});

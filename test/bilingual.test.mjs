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
  assert.deepEqual(search(idx, msg, { limit: 10 }), []);
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

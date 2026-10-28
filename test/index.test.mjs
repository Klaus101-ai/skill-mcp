import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "../core/sources.mjs";
import {
  buildIndex,
  search,
  dedupeByName,
  selectWinner,
  expandQuery,
  boostReorder,
  BOOST_ORDER,
  BOOST_TRIGGER,
} from "../core/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX_ROOT = path.join(HERE, "fixtures", "root");
const { skills } = discoverSkills([FIX_ROOT]);
const index = buildIndex(skills);

test("search by name", () => {
  const results = search(index, "banana", { limit: 5 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].name, "skill-beta");
  assert.ok(typeof results[0].score === "number");
  assert.ok(results[0].path.endsWith("SKILL.md"));
});

test("search by description", () => {
  const results = search(index, "zebra", { limit: 5 });
  assert.ok(results.some((r) => r.name === "skill-delta"));
  assert.ok(results.some((r) => r.name === "skill-omega"));
});

test("why: one line, <=160 chars, non-empty", () => {
  const results = search(index, "zebra", { limit: 5 });
  for (const r of results) {
    assert.ok(r.why.length > 0);
    assert.ok(r.why.length <= 160, `why too long: ${r.why.length}`);
    assert.ok(!r.why.includes("\n"), "why must be a single line");
  }
});

test("empty, whitespace and punctuation-only queries return []", () => {
  assert.deepEqual(search(index, ""), []);
  assert.deepEqual(search(index, "   "), []);
  assert.deepEqual(search(index, "!!! ??? ..."), []);
  assert.deepEqual(search(index, "---"), []);
  assert.deepEqual(search(index, 42), []);
});

test("random words without matches return []", () => {
  assert.deepEqual(search(index, "qqqzzzxyw nonexistenttoken"), []);
});

test("restrict_to filters by exact name", () => {
  const results = search(index, "zebra", { limit: 5, restrict_to: ["skill-delta"] });
  assert.deepEqual(results.map((r) => r.name), ["skill-delta"]);
});

test("restrict_to filters by wildcard pattern", () => {
  const results = search(index, "zebra", { limit: 5, restrict_to: ["skill-*"] });
  assert.deepEqual(results.map((r) => r.name), ["skill-delta", "skill-omega"]);
});

test("restrict_to with no matching names returns []", () => {
  const results = search(index, "zebra", { limit: 5, restrict_to: ["no-such-skill"] });
  assert.deepEqual(results, []);
});

test("deterministic order: equal scores break ties by name asc", () => {
  const first = search(index, "zebra", { limit: 5 }).map((r) => r.name);
  const second = search(index, "zebra", { limit: 5 }).map((r) => r.name);
  assert.deepEqual(first, second);
  // skill-delta and skill-omega have identical text -> equal scores.
  const tied = first.filter((n) => n === "skill-delta" || n === "skill-omega");
  assert.deepEqual(tied, ["skill-delta", "skill-omega"]);
});

test("limit caps the number of results", () => {
  const results = search(index, "zebra", { limit: 1 });
  assert.equal(results.length, 1);
});

test("why: stop words and single-character terms are dropped, at most 6 terms", () => {
  const idx = buildIndex([
    {
      name: "why-fixture",
      path: "C:/x/why-fixture/SKILL.md",
      description: "review of the contract for and with a team in on the fly z",
      bodyHeadings: [],
    },
  ]);
  const [hit] = search(idx, "review of the contract for and with a team z", { limit: 5 });
  assert.ok(hit, "expected a hit");
  const m = /:\s*(.+)$/.exec(hit.why);
  assert.ok(m, `why has no term list: ${hit.why}`);
  const terms = m[1].split(", ");
  assert.ok(terms.includes("review"), hit.why);
  assert.ok(terms.includes("contract"), hit.why);
  assert.ok(terms.length <= 6, `more than 6 terms: ${hit.why}`);
  const stops = new Set([
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
    "и", "в", "во", "на", "по", "с", "со", "к", "о", "об", "от", "до", "за", "из", "не",
  ]);
  for (const t of terms) {
    assert.ok(t.length > 1, `single-character term in why: "${t}" (${hit.why})`);
    assert.ok(!stops.has(t.toLowerCase()), `stop word in why: "${t}" (${hit.why})`);
  }
});

test("why: query made only of stop words and junk still yields a non-empty single line", () => {
  const idx = buildIndex([
    { name: "why-fixture-2", path: "C:/x/why-fixture-2/SKILL.md", description: "and the of", bodyHeadings: [] },
  ]);
  const results = search(idx, "and the of", { limit: 5 });
  if (results.length > 0) {
    for (const r of results) {
      assert.ok(r.why.length > 0);
      assert.ok(!r.why.includes("\n"));
      assert.ok(r.why.length <= 160);
    }
  }
});

test("search collapses duplicate skill names to the highest score", () => {
  const idx = buildIndex([
    { name: "dup-skill", path: "C:/x/beta/dup-skill/SKILL.md", description: "zebra hunt with extra zebra details", bodyHeadings: [] },
    { name: "dup-skill", path: "C:/x/alpha/dup-skill/SKILL.md", description: "zebra hunt", bodyHeadings: [] },
    { name: "other-skill", path: "C:/x/alpha/other-skill/SKILL.md", description: "zebra hunt", bodyHeadings: [] },
  ]);
  const results = search(idx, "zebra", { limit: 10 });
  const dups = results.filter((r) => r.name === "dup-skill");
  assert.equal(dups.length, 1, "duplicate names must collapse");
  // beta has the richer description -> higher score wins regardless of path order.
  assert.ok(dups[0].path.endsWith("beta/dup-skill/SKILL.md"), dups[0].path);
  assert.ok(results.some((r) => r.name === "other-skill"));
});

test("search: equal scores among duplicate names keep the smaller path", () => {
  const same = { description: "zebra hunt", bodyHeadings: [] };
  const idx = buildIndex([
    { name: "dup-skill", path: "C:/x/zeta/dup-skill/SKILL.md", ...same },
    { name: "dup-skill", path: "C:/x/alpha/dup-skill/SKILL.md", ...same },
  ]);
  const results = search(idx, "zebra", { limit: 10 });
  assert.equal(results.length, 1);
  assert.ok(results[0].path.startsWith("C:/x/alpha/"), results[0].path);
});

test("dedupeByName keeps the winner at the name's first position", () => {
  const list = [
    { name: "a", path: "2", score: 5 },
    { name: "b", path: "3", score: 4 },
    { name: "a", path: "1", score: 9 },
  ];
  const out = dedupeByName(list);
  assert.equal(out.length, 2);
  assert.equal(out[0], list[2], "a keeps its best-scoring copy at the first position of that name");
  assert.equal(out[1], list[1], "b is untouched");
});

test("selectWinner: highest score wins, ties break by smaller path", () => {
  const c = [
    { name: "s", path: "b/p.md", score: 1 },
    { name: "s", path: "a/p.md", score: 1 },
    { name: "s", path: "c/p.md", score: 5 },
  ];
  assert.equal(selectWinner(c).path, "c/p.md");
  assert.equal(selectWinner(c.slice(0, 2)).path, "a/p.md");
});

test("selectWinner: without scores the lexicographically first path wins; empty list is null", () => {
  assert.equal(selectWinner([{ name: "s", path: "z/x.md" }, { name: "s", path: "a/x.md" }]).path, "a/x.md");
  assert.equal(selectWinner([]), null);
  assert.equal(selectWinner(null), null);
  assert.equal(selectWinner(undefined), null);
});

// ── v0.4: каждый элемент несёт description (кандидаты, а не один ответ) ─────

test("v0.4: every search item carries the skill description", () => {
  const results = search(index, "zebra", { limit: 5 });
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.equal(typeof r.description, "string", `${r.name}: no description field`);
  }
  const delta = results.find((r) => r.name === "skill-delta");
  assert.ok(delta.description.includes("zebra operations manual"), delta.description);
  // a skill without a frontmatter description → ""
  const plainIdx = buildIndex([
    { name: "skill-no-desc", path: "C:/x/skill-no-desc/SKILL.md", bodyHeadings: ["Some heading"] },
  ]);
  assert.equal(search(plainIdx, "heading", { limit: 5 })[0]?.description, "");
});

// ── v0.3: the result list is not gated any more, `confident` marks the rule ─

test("v0.3: every returned position carries a boolean confident flag", () => {
  const results = search(index, "zebra", { limit: 5 });
  assert.ok(results.length >= 1);
  for (const r of results) assert.equal(typeof r.confident, "boolean", `${r.name}: no confident flag`);
});

test("v0.3: a raw match covering too little is returned with confident:false", () => {
  const idx = buildIndex([
    { name: "skill-one", path: "C:/x/skill-one/SKILL.md", description: "zebra handbook only", bodyHeadings: [] },
  ]);
  // v0.6.3 (owner task 27.10.2026): a 2-token query is now proven by one
  // token (need = 1), so the "too little" case is exercised at N = 3 where
  // need is still 2 — «zebra quokka» would be confident since v0.6.3.
  const results = search(idx, "zebra quokka donut", { limit: 5 }); // N = 3, one token matched
  assert.equal(results.length, 1, "the raw match must be returned (search is not gated)");
  assert.equal(results[0].name, "skill-one");
  assert.equal(results[0].confident, false, "1 of 3 significant tokens proves nothing");
});

test("v0.3: a fully covered match is confident", () => {
  const idx = buildIndex([
    { name: "skill-two", path: "C:/x/skill-two/SKILL.md", description: "zebra quokka handbook", bodyHeadings: [] },
  ]);
  const results = search(idx, "zebra quokka", { limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].confident, true, "2 of 2 significant tokens");
});

// ── v0.3.1: confident positions rank above unconfirmed ones ─────────────────

test("v0.3.1: a confident result outranks an unconfirmed one with a higher score", () => {
  const s = (name, description) => ({ name, path: `C:/x/${name}/SKILL.md`, description, bodyHeadings: [] });
  const idx = buildIndex([
    s("skill-proven", "banana split"),
    s("skill-filler1", "banana split text"),
    s("skill-filler2", "banana split notes"),
    s("skill-filler3", "banana split stuff"),
    s("skill-noise", "zebra zebra zebra zebra zebra zebra"),
  ]);
  const results = search(idx, "banana split zebra", { limit: 10 }); // N = 3 → need 2
  const noise = results.find((r) => r.name === "skill-noise");
  const proven = results.find((r) => r.name === "skill-proven");
  assert.equal(noise.confident, false, "1 of 3 tokens never proves the topic");
  assert.equal(proven.confident, true, "2 of 3 tokens do");
  // premise: BM25 really scores the unconfirmed hit higher (zebra is rare, so
  // its repeated term frequency outweighs two common covered tokens)
  assert.ok(noise.score > proven.score, `premise broken: noise ${noise.score} vs proven ${proven.score}`);
  assert.ok(
    results.indexOf(proven) < results.indexOf(noise),
    `confident must rank first: ${results.map((r) => `${r.name}:${r.confident ? "T" : "F"}`).join(", ")}`,
  );
  // and no unconfirmed position may sit above a confident one
  const firstUnconfirmed = results.findIndex((r) => r.confident === false);
  assert.ok(
    firstUnconfirmed === -1 || results.slice(firstUnconfirmed).every((r) => r.confident === false),
    "the confident group must be contiguous at the top",
  );
});

// ── v0.4.1: расширение запроса и доменный буст (variant G) ─────────────────
// Owner decision 26.10.2026 (variants lab): «описан…» → +«текст»,
// «продукт…» → +« product»; BOOST_ORDER skills rise to the top of a
// trigger-matched pool. Everything below runs on IN-MEMORY fixtures — no
// dependency on the real skill corpus.

test("v0.4.1: expandQuery — «описан…» adds «текст», «продукт…» adds «product»", () => {
  assert.equal(expandQuery("описание продукта"), "описание продукта текст product");
  assert.equal(expandQuery("ОПИСАНИЕ"), "ОПИСАНИЕ текст", "case-insensitive, appended lower-case");
  assert.equal(expandQuery("описания услуг"), "описания услуг текст", "any «описан…» form");
  assert.equal(expandQuery("лендинг про продукт"), "лендинг про продукт product");
  assert.equal(expandQuery("zebra operations"), "zebra operations", "no trigger → unchanged");
  assert.equal(expandQuery("скилл тест"), "скилл тест");
});

test("v0.4.1: BOOST_TRIGGER fires on the five domain words only", () => {
  for (const w of ["описание", "описания", "описании", "текст", "лендинг", "копирайт", "продукт", "продуктов"]) {
    assert.ok(BOOST_TRIGGER.test(w), `trigger must fire on «${w}»`);
  }
  for (const w of ["договор", "тесты", "настройка", "бюджет", "данные"]) {
    assert.ok(!BOOST_TRIGGER.test(w), `trigger must NOT fire on «${w}»`);
  }
});

test("v0.4.1: expansion reaches the search — a «текст» skill is found by «описание» alone", () => {
  const idx = buildIndex([
    { name: "skill-text", path: "C:/x/skill-text/SKILL.md", description: "текст для сайта: редактура и вычитка", bodyHeadings: [] },
    { name: "skill-unrelated", path: "C:/x/skill-unrelated/SKILL.md", description: "совсем другое про котов", bodyHeadings: [] },
  ]);
  // «описание» does NOT occur in the fixture — only the ADDED «текст» token
  // can bring skill-text back, so this hit proves the expansion ran.
  const results = search(idx, "описание", { limit: 5 });
  assert.deepEqual(results.map((r) => r.name), ["skill-text"], "the added token must reach the index");
  // v0.6.3 (owner task 27.10.2026): the expanded query «описание текст» has
  // N = 2 → need 1, so the covered added token alone IS confident now (the
  // old min(2, N) = 2 demanded both — this expectation changed with the rule).
  assert.equal(results[0].confident, true, "1 of 2 expanded tokens proves it since v0.6.3");
  // control: a trigger-less query stays unexpanded and finds nothing here
  assert.deepEqual(search(idx, "зелень погода", { limit: 5 }), []);
});

test("v0.4.1: the added token counts toward confident (sig runs on the EXPANDED query)", () => {
  const idx = buildIndex([
    { name: "skill-desc-text", path: "C:/x/skill-desc-text/SKILL.md", description: "описания текстов для сайтов", bodyHeadings: [] },
  ]);
  // «опиши описание продукта» → expanded: +«текст» +« product» → N=5, need 2;
  // the doc covers «описан» (own text) + «текст» (the ADDED token) → confident.
  // On the unexpanded query the same doc would cover only «описан» (1 < 2).
  const results = search(idx, "опиши описание продукта", { limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].confident, true, "the added «текст» must count toward the coverage rule");
});

test("v0.4.1: boostReorder — BOOST_ORDER first in order, then the rest; stable, no additions", () => {
  assert.deepEqual(BOOST_ORDER, [
    "promo",
    "copywriting",
    "site-copywriting",
    "app-copywriting",
    "documentation-and-adrs",
    "redpolitika",
  ]);
  const hits = [
    { name: "zeta", score: 9 },
    { name: "promo", score: 1 },
    { name: "alpha", score: 8 },
    { name: "redpolitika", score: 2 },
    { name: "copywriting", score: 3 },
    { name: "promo", score: 0 }, // duplicate name: the FIRST occurrence wins
  ];
  const out = boostReorder(hits);
  assert.deepEqual(out.map((h) => h.name), ["promo", "copywriting", "redpolitika", "zeta", "alpha"]);
  assert.equal(out.length, 5, "dedup by name, nothing added or dropped");
  assert.equal(out[0].score, 1, "first occurrence of a duplicated name wins");
  assert.deepEqual(boostReorder(null), [], "non-array input is safe");
  assert.deepEqual(boostReorder([]), []);
});

test("v0.4.1: trigger query — BOOST_ORDER members rise to the top of the capped pool", () => {
  const s = (name, description) => ({ name, path: `C:/x/${name}/SKILL.md`, description, bodyHeadings: [] });
  const idx = buildIndex([
    s("promo", "лендинги и продающие тексты для страницы продукта с описанием услуг"),
    s("описание-продукта-alpha", "описание продукта подробное и документированное"),
    s("описание-продукта-gamma", "описание продукта краткое и понятное"),
    s("skill-unrelated", "совсем другое про котов и зелень"),
  ]);
  const pool = search(idx, "описание продукта", { limit: 10 });
  assert.equal(pool.length, 3, "three matching docs (the unrelated one stays out)");
  assert.equal(pool[0].name, "promo", "the BOOST_ORDER skill must lead the boosted pool");
  // composition unchanged — the boost only reorders (sorted comparison:
  // default JS order puts the Latin 'promo' before the Cyrillic names)
  assert.deepEqual(
    pool.map((h) => h.name).sort(),
    ["promo", "описание-продукта-alpha", "описание-продукта-gamma"],
  );
});

test("v0.4.1: the boost never adds — a domain skill cut by the limit stays out", () => {
  const s = (name, description) => ({ name, path: `C:/x/${name}/SKILL.md`, description, bodyHeadings: [] });
  const idx = buildIndex([
    s("promo", "лендинги и продающие тексты для страницы продукта с описанием услуг"),
    s("описание-продукта-alpha", "описание продукта подробное и документированное"),
    s("описание-продукта-gamma", "описание продукта краткое и понятное"),
    s("skill-unrelated", "совсем другое про котов и зелень"),
  ]);
  // the distractors carry the query tokens in their NAME (weight x3) and
  // outrank promo organically; with limit 1 promo is cut BY THE CAP —
  // the boost runs after the cap and must not resurrect it.
  const capped = search(idx, "описание продукта", { limit: 1 });
  assert.equal(capped.length, 1, "cap to 1 first");
  assert.notEqual(capped[0].name, "promo", "the boost must not add a skill outside the pool");
  // with room for all three the same boost puts promo first
  assert.equal(search(idx, "описание продукта", { limit: 10 })[0].name, "promo");
});

test("v0.4.1: no trigger → order untouched by the boost (score order holds)", () => {
  const idx = buildIndex([
    { name: "skill-a", path: "C:/x/skill-a/SKILL.md", description: "zebra operations manual alpha", bodyHeadings: [] },
    { name: "skill-b", path: "C:/x/skill-b/SKILL.md", description: "zebra operations manual omega", bodyHeadings: [] },
  ]);
  const results = search(idx, "zebra operations", { limit: 5 });
  assert.equal(results.length, 2);
  assert.ok(results[0].score >= results[1].score, "plain score order for a trigger-less query");
});

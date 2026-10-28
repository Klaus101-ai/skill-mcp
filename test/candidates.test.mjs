// v0.4 (owner decision 26.10.2026, «5 кандидатов»): the hint is a CANDIDATE
// list — up to 5 entries, confident first, unconfirmed ones marked
// «(возможно)», the choice belongs to the agent's model.
// v0.6.2 (owner task 27.10.2026): the note reads «посмотри описания
// кандидатов; если один подходит — загрузи его через skill; если нет — не
// загружай.» — candidates are to be COMPARED by description and the matching
// one LOADED, never skipped as «just candidates».
// v0.4.1 (owner decision 26.10.2026, variant G): query expansion
// («описание»→+«текст», «продукт»→+«product») + domain BOOST_ORDER raise
// promo to position 1; a tool-silence question (Q2) and a pool with no
// `confident:true` position produce NO block. The three owner verification
// queries (Q1/Q2/Q3) run against an IN-MEMORY fixture index (`discover`
// override) — nothing here depends on the real 365-skill corpus.
import test from "node:test";
import assert from "node:assert/strict";
import { createContextHook, HINT_TAG, HINT_NOTE, MAX_ITEMS, MAX_BLOCK_CHARS } from "../plugin/hint.mjs";
import { buildIndex, search, expandQuery } from "../core/index.mjs";

const Q1 =
  "Мы сделали skill-mcp и выложили на гитхаб. Но описание как будто набор технических данных. Без толкового описания. Найди скилы, которые умеют делать правильное описание для своих продуктов, когда я их буду выкладывать";
const Q2 = "а почему твой плагин не нашел этот скил и не активировал при создании?";
const Q3 = "опиши продукт";

function s(name, description) {
  return { name, path: `C:/x/${name}/SKILL.md`, description, bodyHeadings: [] };
}

// Fixture pool: `promo` is the analogue of the real corpus's copywriting
// skill (the one Q1/Q3 must reach); the rest are plausible distractors that
// share one or two query tokens each.
const FIXTURE_SKILLS = [
  s(
    "promo",
    // v0.6.1: the CURRENT live-corpus description (shortened; no literal «опиши
    // продукт» trigger) so Q1/Q3 exercise the real scenario that regressed —
    // the verb «опиши» must expand (via the «опиш» trigger) for promo to reach
    // the confident pool and lead it after the domain boost.
    "Продающие лендинги и промостраницы на русском: офферы, заголовки, CTA, описания продукта и тексты для лендинга.",
  ),
  s("skill-creator", "Create new skills, modify and improve existing SKILL.md files. Use when users want to create a skill from scratch."),
  s("app-copywriting", "Тексты для приложений: экраны, микротексты, состояния, тексты карточки в RuStore."),
  s("site-copywriting", "Тексты многостраничных сайтов: hero, карточки, разделы сайта, проверка читаемости."),
  s("git-share", "Push a repository to github and share the remote URL with the team."),
  s("skill-mcp-docs", "Technical data dump helper: tables, versions and identifiers for product metadata of skill-mcp."),
  s("plugin-guide", "Настройка плагинов opencode: подключение, конфиги, загрузка плагина при старте сессии."),
  s("skill-install", "Установка и активация скиллов при создании проекта: directories, discovery, restart."),
  s("review-quality", "Conducts multi-axis code review before merging any change."),
  s("zebra-filler", "zebra operations manual for tie tests."),
];

function hook() {
  return createContextHook({
    // Phase 1a (28.10.2026): the hint-shape tests run with the always-on
    // router rule OFF — its own behaviour is covered by test/router-rule.test.mjs.
    env: { SKILL_MCP_RULE: "off" },
    debug: false,
    discover: () => ({ skills: FIXTURE_SKILLS }),
  });
}

function run(query) {
  const ev = {
    agent: "tester",
    system: [{ type: "text", text: "preamble part" }],
    messages: [{ role: "user", content: [{ type: "text", text: query }] }],
  };
  hook()(ev);
  return ev;
}

function entryLines(block) {
  return block.split("\n").filter((l) => l.startsWith("- "));
}

function entryNames(block) {
  return entryLines(block).map((l) => l.slice(2).replace(" (возможно)", "").split(":")[0]);
}

function lineOf(block, name) {
  return entryLines(block).find((l) => l.startsWith(`- ${name}`) || l.startsWith(`- ${name} (возможно)`));
}

test("Q1 (G): блок ≤5 кандидатов, promo позиция 1, note новый", () => {
  const ev = run(Q1);
  assert.equal(ev.system.length, 2, "a candidate block must form for Q1");
  const block = ev.system[1].text;
  assert.equal(block.split("\n")[0], HINT_TAG);
  assert.equal(HINT_NOTE, "посмотри описания кандидатов; если один подходит — загрузи его через skill; если нет — не загружай.");
  const entries = entryLines(block);
  assert.ok(entries.length >= 1 && entries.length <= MAX_ITEMS, `entries: ${entries.length}`);
  assert.ok(block.length <= MAX_BLOCK_CHARS, `block ${block.length} chars`);
  // v0.4.1 G: the expansion + BOOST_ORDER raise promo to the very top
  assert.equal(entryNames(block)[0], "promo", `promo must be #1: ${entryNames(block).join(", ")}`);
  assert.ok(lineOf(block, "promo"), "promo must be a candidate");
  // promo covers the expanded tokens («описан»/«продукт»/«текст») → confident,
  // i.e. no «(возможно)» marker on the domain skill
  assert.ok(lineOf(block, "promo").startsWith("- promo: "), `promo must be unmarked: ${lineOf(block, "promo")}`);
  // v0.6.2: the note must tell the agent to compare the descriptions and load
  // the matching skill («candidates» is not permission to skip loading)
  assert.ok(
    block.includes("посмотри описания кандидатов") && block.includes("загрузи его через skill"),
    "the note must say: read the descriptions and load the matching skill",
  );
});

test("Q2 (G): запрос про сам инструмент (плагин + почему/не нашёл) — блока нет", () => {
  const ev = run(Q2);
  assert.equal(ev.system.length, 1, "tool-silence: a question about the plugin itself gets no hint");
  assert.ok(!ev.system.some((p) => p && typeof p.text === "string" && p.text.includes("<skill_hint")));
});

test("Q3 (G): блок ≤5 кандидатов, promo позиция 1", () => {
  const ev = run(Q3);
  assert.equal(ev.system.length, 2, "a candidate block must form for Q3");
  const block = ev.system[1].text;
  const entries = entryLines(block);
  assert.ok(entries.length >= 1 && entries.length <= MAX_ITEMS, `entries: ${entries.length}`);
  assert.ok(block.length <= MAX_BLOCK_CHARS, `block ${block.length} chars`);
  assert.equal(entryNames(block)[0], "promo", `promo must be #1: ${entryNames(block).join(", ")}`);
  assert.ok(
    block.includes("посмотри описания кандидатов") && block.includes("загрузи его через skill"),
    "the note must say: read the descriptions and load the matching skill",
  );
});

test("G: мусорный запрос без совпадений — блока нет", () => {
  for (const junk of ["Как сварить борщ с говядиной", "афыва123 !!!"]) {
    const ev = run(junk);
    assert.equal(ev.system.length, 1, `no block for ${JSON.stringify(junk)}`);
  }
});

test("G: raw hits, но ни одного confident — confident-гейт молчит (variant G)", () => {
  // «zebra quokka donut» (N=3 → need 2): only zebra-filler matches, and it
  // covers «zebra» alone → the pool has no confident position → no block at
  // all (the v0.4 all-marked block is replaced by the v0.4.1 confident gate).
  // NB: since v0.6.3 the two-token «zebra quokka» IS confident (need = 1 for
  // N ≤ 2) and is asserted as a positive case in the next test.
  const ev = run("zebra quokka donut");
  assert.equal(ev.system.length, 1, "the confident gate must silence the hint");
});

test("v0.6.3: N=2 («zebra quokka») is proven by one token → the block forms, no content part", () => {
  const ev = run("zebra quokka");
  assert.equal(ev.system.length, 2, "need = 1 for a 2-token query → the confident gate opens");
  const block = ev.system[1].text;
  assert.ok(block.startsWith("<skill_hint"), block.slice(0, 60));
  assert.ok(
    block.split("\n").filter((l) => l.startsWith("- ")).some((l) => !l.includes("(возможно)")),
    `a confident entry must be present: ${block}`,
  );
  // this fixture's paths (C:/x/…) do not exist → the v0.6.3 preload fails
  // open and adds NO content part (hint-only), even with the switch enabled
  assert.ok(!ev.system.some((p) => typeof p.text === "string" && p.text.includes("<skill_content")));
});

test("G: find (core search) limit 10 по Q1 — promo в топ-10 и на позиции 1", () => {
  const index = buildIndex(FIXTURE_SKILLS);
  const pool = search(index, Q1, { limit: 10 });
  const names = pool.map((h) => h.name);
  assert.ok(names.length <= 10, `pool ≤10: ${names.length}`);
  assert.ok(names.includes("promo"), `promo must be in the top-10 pool: ${names.join(", ")}`);
  assert.equal(names[0], "promo", `boosted pool must lead with promo: ${names.join(", ")}`);
  // the pool itself is confident somewhere → the hook's gate passes on Q1
  assert.ok(pool.some((h) => h.confident === true), "the Q1 pool must hold a confident position");
});

test("v0.6.1 Q3: find (core search) limit 10 по «опиши продукт» — promo в топ-10 и на позиции 1", () => {
  // The regression the owner's check caught: «опиши» (verb) did not expand, so
  // promo (short live description) fell out of the top-10 pool and the boost
  // only reorders the pool → promo was absent. The «опиш» trigger fixes it.
  const index = buildIndex(FIXTURE_SKILLS);
  const pool = search(index, Q3, { limit: 10 });
  const names = pool.map((h) => h.name);
  assert.ok(names.includes("promo"), `promo must be in the top-10 pool: ${names.join(", ")}`);
  assert.equal(names[0], "promo", `boosted pool must lead with promo: ${names.join(", ")}`);
  assert.ok(pool.some((h) => h.confident === true), "the Q3 pool must hold a confident position");
});

test("v0.6.1: «опиши» (verb) expands like «описание» — +«текст», «продукт» → +«product»", () => {
  assert.equal(expandQuery("опиши продукт"), "опиши продукт текст product");
  assert.equal(expandQuery("опишите услугу"), "опишите услугу текст", "any «опиш…» verb form");
  assert.equal(expandQuery("опишет продукт"), "опишет продукт текст product");
  assert.equal(expandQuery("опишут продукт"), "опишут продукт текст product");
  // existing noun triggers unchanged
  assert.equal(expandQuery("описание продукта"), "описание продукта текст product");
  assert.equal(expandQuery("описания услуг"), "описания услуг текст");
  assert.equal(expandQuery("лендинг про продукт"), "лендинг про продукт product");
  assert.equal(expandQuery("zebra operations"), "zebra operations", "no trigger → unchanged");
});

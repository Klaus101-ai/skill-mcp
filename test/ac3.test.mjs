// M5/M6 AC3: the significant-match gate and the relative noise floor,
// exercised through the PRODUCTION search() (core/index.mjs) and through the
// plugin hint (the plugin shows nothing exactly when search() answers []).
// M6: the match is TOKEN-level — equality of normalized/stemmed tokens, not a
// substring of a longer word (bus∌business, next∌next.js), a hyphen splits a
// word (gsap ⊂ gsap-scrolltrigger), upper-case acronyms are significant.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, search } from "../core/index.mjs";
import { createContextHook } from "../plugin/hint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX_ROOT = path.join(HERE, "fixtures", "root");

function skill(name, description) {
  return { name, path: `C:/x/${name}/SKILL.md`, description, bodyHeadings: [] };
}

test("AC3 gate: a stop-word-only overlap is not a match", () => {
  const idx = buildIndex([skill("skill-stops", "на по с в во о об")]);
  // raw MiniSearch DOES match the query — the docs contain на/по/с …
  assert.ok(idx.search("на по с борщ").length >= 1, "raw index must see the stop words");
  // … but no meaningful query token occurs in the skill text -> empty answer.
  assert.deepEqual(search(idx, "на по с борщ", { limit: 5 }), []);
});

test("AC3 gate: a query made only of stop words and short tokens returns []", () => {
  const idx = buildIndex([skill("skill-stops", "на по с в во о об и the of")]);
  assert.deepEqual(search(idx, "на по с the of", { limit: 5 }), []);
  assert.deepEqual(search(idx, "ai go", { limit: 5 }), []);
});

test("AC3 gate: meaningful tokens present in name/description/headings keep the result", () => {
  const idx = buildIndex([
    skill("skill-flowers", "как ухаживать за цветами: полив и пересадка"),
    skill("skill-other", "совсем другой текст про котов"),
  ]);
  const results = search(idx, "как ухаживать за цветами", { limit: 5 });
  assert.ok(results.length >= 1, "expected the flower skill");
  assert.equal(results[0].name, "skill-flowers");
});

test("AC3 gate: case endings match through stemming («договора» vs «договоров»)", () => {
  const idx = buildIndex([skill("skill-lease", "договоров аренды офиса и склада")]);
  const results = search(idx, "договора", { limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "skill-lease");
});

test("relative threshold: one weak meaningful token among absent ones is cut", () => {
  const idx = buildIndex([skill("skill-flowers", "цветы и полив подоконника")]);
  // the gate PASSES this («цветы» really occurs) — the ceiling check then
  // rejects it: two of three meaningful tokens are absent from the corpus.
  assert.deepEqual(search(idx, "цветы гонконг фуникулер", { limit: 5 }), []);
});

test("relative threshold: matching every meaningful token (or the only one) is kept", () => {
  const idx = buildIndex([skill("skill-mixed", "цветы гонконг фуникулер уход")]);
  assert.ok(search(idx, "цветы гонконг фуникулер", { limit: 5 }).length >= 1, "full match must survive");
  assert.ok(search(idx, "цветы", { limit: 5 }).length >= 1, "single-token match must survive");
});

test("gate + threshold do not break restrict_to", () => {
  const idx = buildIndex([
    skill("skill-a", "zebra operations manual"),
    skill("skill-b", "zebra operations manual"),
  ]);
  assert.deepEqual(search(idx, "zebra", { limit: 5, restrict_to: ["skill-b"] }).map((r) => r.name), ["skill-b"]);
  assert.deepEqual(search(idx, "zebra", { limit: 5, restrict_to: ["no-such"] }), []);
});

// ── M6: token-level match, word rule (dot / hyphen), acronyms ───────────────

test("M6 token-level: «bus» does not match the words business/abuse", () => {
  const idx = buildIndex([
    skill("skill-biz", "business website builder"),
    skill("skill-abuse", "abuse reporting workflow"),
  ]);
  // «bus» is only a SUBSTRING of those words — a substring is not a match.
  assert.deepEqual(search(idx, "bus", { limit: 5 }), []);
  // … while the real words still match by token equality.
  assert.equal(search(idx, "business", { limit: 5 }).length, 1);
  assert.equal(search(idx, "abuse", { limit: 5 }).length, 1);
});

test("M6 word rule: «next» does not match the word «next.js» (a dot keeps a word together)", () => {
  const idx = buildIndex([skill("skill-nextjs", "Next.js landing page guide")]);
  assert.deepEqual(search(idx, "next", { limit: 5 }), []);
  // the whole word still matches — same rule on both sides of the comparison
  assert.equal(search(idx, "next.js", { limit: 5 }).length, 1);
});

test("M6 hyphen rule: a hyphen SPLITS, so «gsap» matches «gsap-scrolltrigger»", () => {
  const idx = buildIndex([skill("gsap-scrolltrigger", "animation guide for scroll-driven scenes")]);
  assert.equal(search(idx, "gsap", { limit: 5 }).length, 1, "compound must stay findable by one part");
  assert.equal(search(idx, "scrolltrigger", { limit: 5 }).length, 1);
  assert.ok(search(idx, "gsap-scrolltrigger", { limit: 5 }).length >= 1, "whole compound matches too");
});

test("M6 acronyms: upper-case «AI» is meaningful, lower-case «ai» is not", () => {
  const idx = buildIndex([skill("skill-aia", "AI impact assessment framework")]);
  assert.equal(search(idx, "AI", { limit: 5 }).length, 1, "AI-only query must match");
  assert.deepEqual(search(idx, "ai", { limit: 5 }), [], "case is what tells an acronym from a word");
  // and the whitelist does not turn ordinary lowercase words into proofs
  assert.deepEqual(search(idx, "go", { limit: 5 }), []);
});

test("M6 why: a field is credited only on token equality, never on a substring", () => {
  // name «Officer-training» holds «office» only as a substring of «Officer»;
  // the description holds the real word «office».
  const idx = buildIndex([skill("Officer-training", "guidelines about office safety")]);
  const results = search(idx, "office", { limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].why, "matched description: office");
});

// ── the plugin simply shows nothing on the same gate ────────────────────────

function makeEvent(text) {
  return {
    agent: "tester",
    system: [{ type: "text", text: "preamble part" }],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

test("plugin: AC3 query -> no <skill_hint> block at all", () => {
  const ev = makeEvent("Как сварить борщ с говядиной");
  createContextHook({ env: {}, roots: [FIX_ROOT], debug: false })(ev);
  assert.equal(ev.system.length, 1, "no block must be appended");
});

test("plugin: stop-word-only query -> no <skill_hint> block", () => {
  const ev = makeEvent("the of and for with is");
  createContextHook({ env: {}, roots: [FIX_ROOT], debug: false })(ev);
  assert.equal(ev.system.length, 1, "no block must be appended");
});

test("plugin: meaningful match still produces exactly one block", () => {
  const ev = makeEvent("zebra operations");
  createContextHook({ env: {}, roots: [FIX_ROOT], debug: false })(ev);
  assert.equal(ev.system.length, 2, "one block appended");
  assert.ok(ev.system[1].text.includes("skill-delta"));
});

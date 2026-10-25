// M5 AC3: the significant-match gate and the relative noise floor, exercised
// through the PRODUCTION search() (core/index.mjs) and through the plugin
// hint (the plugin shows nothing exactly when search() answers []).
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

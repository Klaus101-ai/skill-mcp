import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX_ROOT = path.join(HERE, "fixtures", "root");
const skills = discoverSkills([FIX_ROOT]);
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

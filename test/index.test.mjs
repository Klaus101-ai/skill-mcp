import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "../core/sources.mjs";
import { buildIndex, search, dedupeByName, selectWinner } from "../core/index.mjs";

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
  const results = search(idx, "zebra quokka", { limit: 5 }); // N = 2, one token matched
  assert.equal(results.length, 1, "the raw match must be returned (search is not gated)");
  assert.equal(results[0].name, "skill-one");
  assert.equal(results[0].confident, false, "1 of 2 significant tokens proves nothing");
});

test("v0.3: a fully covered match is confident", () => {
  const idx = buildIndex([
    { name: "skill-two", path: "C:/x/skill-two/SKILL.md", description: "zebra quokka handbook", bodyHeadings: [] },
  ]);
  const results = search(idx, "zebra quokka", { limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].confident, true, "2 of 2 significant tokens");
});

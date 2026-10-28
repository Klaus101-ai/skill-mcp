// M5/M6 AC3: the significant-match rule and the relative noise floor,
// exercised through the PRODUCTION search() (core/index.mjs) and through the
// plugin hint. v0.3 (owner decision 26.10.2026) split the two consumers:
// search() returns EVERYTHING it found and marks each position with
// `confident` (the former ≥ min(2, N) coverage rule). v0.4 (owner decision
// 26.10.2026, «5 кандидатов») made the hint a CANDIDATE list: it shows up to
// 5 positions from that ranked list (confident first), marks the
// `confident:false` ones «(возможно)» and leaves the choice to the agent's
// model — so `[]` now means "nothing matched at all / nothing significant
// could prove anything", while a raw match that does not cover enough shows
// up as a marked candidate, never as [].
// M6: the match is TOKEN-level — equality of normalized/stemmed tokens, not a
// substring of a longer word (bus∌business, next∌next.js), a hyphen splits a
// word (gsap ⊂ gsap-scrolltrigger), upper-case acronyms are significant.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";
import { createContextHook } from "../plugin/hint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX_ROOT = path.join(HERE, "fixtures", "root");

function skill(name, description) {
  return { name, path: `C:/x/${name}/SKILL.md`, description, bodyHeadings: [] };
}

test("AC3 rule: a stop-word-only overlap is not confident (raw hit kept, flag false)", () => {
  const idx = buildIndex([skill("skill-stops", "на по с в во о об")]);
  // raw MiniSearch DOES match the query — the docs contain на/по/с …
  assert.ok(idx.search("на по с борщ").length >= 1, "raw index must see the stop words");
  // … but no meaningful query token occurs in the skill text: v0.3 keeps the
  // hit in the list (search is no longer gated) and marks it confident:false.
  const results = search(idx, "на по с борщ", { limit: 5 });
  assert.equal(results.length, 1, "the raw match must be returned, not dropped");
  assert.equal(results[0].name, "skill-stops");
  assert.equal(results[0].confident, false, "stop words + an uncovered token prove nothing");
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

test("coverage rule: N=3 with one matched token is not confident (position kept)", () => {
  const idx = buildIndex([skill("skill-flowers", "цветы и полив подоконника")]);
  // «цветы» really occurs (token equality holds), but a lone token never
  // proves the topic: 1 < min(2, 3) → confident:false (M7, no score floor).
  // v0.3: the raw match stays in the output — only the flag says otherwise.
  const results = search(idx, "цветы гонконг фуникулер", { limit: 5 });
  assert.equal(results.length, 1, "the raw match must be returned");
  assert.equal(results[0].name, "skill-flowers");
  assert.equal(results[0].confident, false);
});

test("coverage rule: N=3 fully covered, and N=1 covered by its only token — both kept", () => {
  const idx = buildIndex([skill("skill-mixed", "цветы гонконг фуникулер уход")]);
  assert.ok(search(idx, "цветы гонконг фуникулер", { limit: 5 }).length >= 1, "full match must survive");
  assert.ok(search(idx, "цветы", { limit: 5 }).length >= 1, "N=1 needs its single token (min(2, 1) = 1)");
});

test("gate + coverage do not break restrict_to", () => {
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

// ── M7: standard stop list + coverage rule (no score threshold) ─────────────

test("M7 coverage N=0: only service words → nothing can prove a match → []", () => {
  const idx = buildIndex([
    skill("skill-bus", "bus timetable airport transfer"),
    skill("skill-office", "office supplies and coffee"),
  ]);
  assert.deepEqual(search(idx, "when what should", { limit: 5 }), [], "en service words alone");
  assert.deepEqual(search(idx, "когда что как почему", { limit: 5 }), [], "ru service words alone");
  assert.deepEqual(search(idx, "the of and for with is", { limit: 5 }), [], "M5 short list still holds");
});

test("coverage rule: N=2 is proven by ONE token (v0.6.3), N=3 still needs two", () => {
  const one = buildIndex([skill("skill-office", "office supplies catalog")]);
  const partial = search(one, "office coffee", { limit: 5 });
  assert.equal(partial.length, 1, "1 of 2 meaningful tokens is still returned (v0.3)");
  // v0.6.3 (owner task 27.10.2026): `need = N <= 2 ? 1 : min(2, N)` — a
  // 1–2-token query is proven by one token, so 1 of 2 IS confident now
  // (it was `false` under the old `min(2, N)`; the expectation changed with
  // the rule, the N ≥ 3 expectations below did not).
  assert.equal(partial[0].confident, true, "N=2 → need 1: one covered token proves it");
  const both = buildIndex([skill("skill-coffee", "office coffee machine")]);
  const full = search(both, "office coffee", { limit: 5 });
  assert.equal(full.length, 1, "2 of 2 = minimal proof");
  assert.equal(full[0].confident, true);
});

test("M7 coverage: «office» alone is not confident for a 3-token query (AC3 #59 shape)", () => {
  const idx = buildIndex([
    skill("skill-supplies", "office supplies restocking"),
    skill("skill-beans", "office coffee brewing"),
  ]);
  // «office coffee» is covered by skill-beans only; skill-supplies holds
  // «office» alone and can never prove «coffee»/«buy».
  const results = search(idx, "What coffee should I buy for the office", { limit: 5 });
  assert.deepEqual(
    results.map((r) => [r.name, r.confident]),
    [["skill-beans", true], ["skill-supplies", false]],
    "both raw matches are returned; only the covered one is confident",
  );
  // the same query with «office» as its ONLY meaningful token is confident
  // for both (N=1 needs just its one token)
  assert.deepEqual(
    search(idx, "office", { limit: 5 }).map((r) => r.confident),
    [true, true],
    "N=1 needs just its one token (both hold it)",
  );
});

test("M7 coverage N=5: regression «договор аренды офис депозит продление»", () => {
  const good = buildIndex([
    skill("skill-lease", "договор аренды офиса: депозит и продление"),
    skill("skill-unrelated", "совсем другой текст про котов"),
  ]);
  const kept = search(good, "договор аренды офис депозит продление", { limit: 5 });
  assert.equal(kept[0]?.name, "skill-lease", "the real answer must lead the list");
  assert.equal(kept[0]?.confident, true, "and it must be confident (5 of 5 covered)");
  const weak = buildIndex([skill("skill-contract", "договор только про котов")]);
  const partial = search(weak, "договор аренды офис депозит продление", { limit: 5 });
  assert.equal(partial.length, 1, "the raw match is returned (v0.3)");
  assert.equal(partial[0].confident, false, "1 of 5 meaningful tokens is not coverage");
});

test("M7 coverage: the AC3 junk queries keep their raw hits but prove nothing", () => {
  const idx = buildIndex([
    skill("skill-when", "guidance for when the build breaks"), // «when» only
    skill("skill-next", "the next release checklist"), // «next» only
  ]);
  // #58: significant tokens are bus/airport — absent from every skill text, so
  // the service-word hits (when/next/the) are returned but confident:false.
  const fiftyEight = search(idx, "When is the next bus to the airport", { limit: 5 });
  assert.equal(fiftyEight.length, 2, "raw matches survive (v0.3)");
  assert.ok(fiftyEight.every((r) => r.confident === false), "nothing can prove bus/airport");
  // #59: «should»/«what» are service words; neither skill holds coffee/buy/office.
  const fiftyNine = search(idx, "What coffee should I buy for the office", { limit: 5 });
  assert.equal(fiftyNine.length, 2, "raw matches survive (v0.3)");
  assert.ok(fiftyNine.every((r) => r.confident === false), "a service-word overlap proves nothing");
});

test("M7: scores rank the list, they never validate it (no MIN_STRENGTH left)", () => {
  // two docs sharing 2 of 2 tokens are both kept regardless of their scores:
  // a weak-but-covered second hit is returned, not silently dropped.
  const idx = buildIndex([
    skill("skill-strong", "zebra operations manual"),
    skill("skill-weak", "zebra operations with far more words around it"),
  ]);
  const results = search(idx, "zebra operations", { limit: 5 });
  assert.equal(results.length, 2, "both covered results survive");
  assert.ok(results[0].score >= results[1].score, "order is still by score");
  assert.ok(results.every((r) => /zebra/.test(r.why)), "both report their real match");
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
  createContextHook({ env: { SKILL_MCP_PRELOAD: "off", SKILL_MCP_RULE: "off" }, roots: [FIX_ROOT], debug: false })(ev);
  assert.equal(ev.system.length, 1, "no block must be appended");
});

test("plugin: stop-word-only query -> no <skill_hint> block", () => {
  const ev = makeEvent("the of and for with is");
  createContextHook({ env: { SKILL_MCP_PRELOAD: "off", SKILL_MCP_RULE: "off" }, roots: [FIX_ROOT], debug: false })(ev);
  assert.equal(ev.system.length, 1, "no block must be appended");
});

test("plugin: meaningful match still produces exactly one block", () => {
  const ev = makeEvent("zebra operations");
  createContextHook({ env: { SKILL_MCP_PRELOAD: "off", SKILL_MCP_RULE: "off" }, roots: [FIX_ROOT], debug: false })(ev);
  assert.equal(ev.system.length, 2, "one block appended");
  assert.ok(ev.system[1].text.includes("skill-delta"));
});

// ── v0.3: search and hint are split (owner decision 26.10.2026) ─────────────

const FIX_INDEX = buildIndex(discoverSkills([FIX_ROOT]).skills);

test("v0.3: search returns the raw hits instead of [] — and since v0.6.3 «banana zebra» is confident", () => {
  // «banana zebra» (N = 2): skill-beta holds «banana», delta/omega «zebra» —
  // under the OLD min(2, N) nobody covered both, so every flag was false.
  // v0.6.3 (owner task 27.10.2026): need = 1 for N = 2, one covered token
  // proves a two-token query — all three positions are confident now. The
  // «search is not gated» part of this test is unchanged: the same three raw
  // positions are returned either way.
  const results = search(FIX_INDEX, "banana zebra", { limit: 10 });
  assert.deepEqual(
    results.map((r) => [r.name, r.confident]),
    [
      ["skill-beta", true],
      ["skill-delta", true],
      ["skill-omega", true],
    ],
  );
});

test("v0.4.1: no confident position → the hint stays silent (confident gate, variant G)", () => {
  // v0.3 stayed silent here; v0.4 showed the candidates (all marked); v0.4.1
  // (owner decision 26.10.2026, variant G) silences the hint again: without a
  // single `confident:true` position in the pool no block is built.
  // v0.6.3 (owner task 27.10.2026) moved the gate's floor for 2-token queries
  // (need = 1), so «banana zebra» is confident now and no longer exercises the
  // gate — the query below is N = 3 (need 2): beta covers «banana» alone,
  // delta/omega cover «zebra» alone, nobody covers two tokens → silence.
  const ev = makeEvent("banana zebra quokka");
  createContextHook({ env: { SKILL_MCP_PRELOAD: "off", SKILL_MCP_RULE: "off" }, roots: [FIX_ROOT], debug: false })(ev);
  assert.equal(ev.system.length, 1, "raw hits exist but nothing is confident → no block");
  assert.ok(!ev.system.some((p) => p && typeof p.text === "string" && p.text.includes("<skill_hint")));
  // control: the old two-token query IS hinted now (N=2 → need 1)
  const two = makeEvent("banana zebra");
  createContextHook({ env: { SKILL_MCP_PRELOAD: "off", SKILL_MCP_RULE: "off" }, roots: [FIX_ROOT], debug: false })(two);
  assert.equal(two.system.length, 2, "v0.6.3: a 2-token query with confident hits → block");
});

test("v0.3: empty/punctuation query -> [] from search and no hint block", () => {
  assert.deepEqual(search(FIX_INDEX, ""), []);
  assert.deepEqual(search(FIX_INDEX, "   "), []);
  assert.deepEqual(search(FIX_INDEX, "!!! ... ---"), []);
  const ev = makeEvent("!!! ... ---");
  createContextHook({ env: { SKILL_MCP_PRELOAD: "off", SKILL_MCP_RULE: "off" }, roots: [FIX_ROOT], debug: false })(ev);
  assert.equal(ev.system.length, 1, "no letters -> no hint");
});

test("v0.3: hint on «проверь договор поставки» contains supply-contract-review", (t) => {
  const { skills } = discoverSkills(defaultRoots());
  if (!skills.some((s) => s.name === "supply-contract-review")) {
    t.skip("supply-contract-review not in the default roots on this host");
    return;
  }
  const hook = createContextHook({ env: { SKILL_MCP_PRELOAD: "off", SKILL_MCP_RULE: "off" }, debug: false });
  // This test creates the hook and calls it in the SAME tick, so the v0.6.3
  // pre-warm (scheduled on setImmediate at factory time) has not fired yet:
  // the first call still pays the index build and is dropped by the 150 ms
  // guard; the measured call runs against the built index. In production
  // setup() and the first dispatch are far apart, so the pre-warmed first
  // call fits the budget (see test/plugin.test.mjs, v0.6.3 pre-warm).
  hook(makeEvent("warm-up: index build, not asserted"));
  const ev = makeEvent("проверь договор поставки");
  hook(ev);
  assert.equal(ev.system.length, 2, "confident match -> exactly one block");
  assert.ok(
    ev.system[1].text.includes("supply-contract-review"),
    `block must name supply-contract-review: ${ev.system[1].text}`,
  );
});

// ── v0.6.3 (owner task 27.10.2026, item 1): need = N <= 2 ? 1 : min(2, N) ───

test("v0.6.3 need: N=1 → 1, N=2 → 1, N≥3 → 2, N=0 → []", () => {
  const idx = buildIndex([
    skill("skill-a", "office supplies catalog"), // covers «office» only
    skill("skill-b", "office coffee machine"), // covers «office» + «coffee»
    skill("skill-c", "цветы и полив подоконника"), // covers «цветы» only
  ]);
  // N = 1 → need 1 (unchanged: min(2, 1) was already 1)
  assert.equal(search(idx, "цветы", { limit: 5 })[0]?.confident, true, "N=1 → need 1");
  assert.equal(search(idx, "цветы", { limit: 5 }).length, 1, "N=1 → its single token proves it");
  // N = 2 → need 1 (CHANGED by v0.6.3: min(2, 2) = 2 used to demand both)
  const n2 = search(idx, "office coffee", { limit: 5 });
  assert.equal(n2.find((r) => r.name === "skill-a")?.confident, true, "N=2 → need 1: one covered token proves");
  assert.equal(n2.find((r) => r.name === "skill-b")?.confident, true, "N=2 → 2 of 2 is still confident");
  // N = 3 → need 2 (unchanged): a lone token never proves a longer query
  const n3 = search(idx, "цветы гонконг фуникулер", { limit: 5 });
  assert.equal(n3.find((r) => r.name === "skill-c")?.confident, false, "N=3 → need 2, one token is not enough");
  // N = 0 (service words only) → nothing can prove a match → []
  assert.deepEqual(search(idx, "на по с", { limit: 5 }), []);
});

test("v0.6.3: «Составь текст» → a confident candidate (the one holding «текст»)", () => {
  const idx = buildIndex([
    skill("skill-texty", "составление текстов для соцсетей и постов"),
    skill("skill-noise", "совсем другое про котов и зелень"),
  ]);
  const results = search(idx, "Составь текст", { limit: 5 });
  assert.ok(results.length >= 1, "the raw hit must be returned");
  assert.equal(results[0].name, "skill-texty");
  assert.equal(results[0].confident, true, "N=2 («составь»+«текст») → need 1: «текст» proves it");
  // control: a skill without «текст» is not confident for the same query
  const other = buildIndex([skill("skill-noise", "совсем другое про котов и зелень")]);
  assert.ok(
    search(other, "Составь текст", { limit: 5 }).every((r) => r.confident === false),
    "no covered token → not confident",
  );
});

test("v0.6.3: «Составь текст» on the real corpus → confident hit AND a hint block", (t) => {
  const { skills } = discoverSkills(defaultRoots());
  const idx = buildIndex(skills);
  const results = search(idx, "Составь текст", { limit: 10 });
  if (!results.some((r) => r.confident === true)) {
    t.skip("no «текст»-carrying skill in the default roots on this host");
    return;
  }
  // NB: v0.4.1's domain boost may lift a BOOST_ORDER member to position 1
  // regardless of its flag, so the confident position is asserted as
  // "somewhere in the pool" (the gate input), not as results[0].
  // the confident gate opens → the plugin builds its block (hint-only mode:
  // the separate preload part is switched off here, its shape is asserted in
  // test/plugin.test.mjs)
  const hook = createContextHook({ env: { SKILL_MCP_PRELOAD: "off", SKILL_MCP_RULE: "off" }, debug: false });
  hook(makeEvent("warm-up: index build, not asserted"));
  const ev = makeEvent("Составь текст");
  hook(ev);
  assert.equal(ev.system.length, 2, "confident candidates → the hint block forms");
  const block = ev.system[1].text;
  assert.ok(block.startsWith("<skill_hint"), block.slice(0, 60));
  const entries = block.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(entries.length >= 1, `no entries: ${block}`);
  assert.ok(
    entries.some((l) => !l.includes("(возможно)")),
    `the confident head must be unmarked: ${entries.join(" | ")}`,
  );
});

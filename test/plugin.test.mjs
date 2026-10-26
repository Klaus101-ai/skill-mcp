// Tests for the skill-router context hint hook (spec §7, R1–R6).
// Plain node:test — the hook is called with a fake context event, no live
// opencode and no plugin registration required.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createContextHook,
  buildHintBlock,
  isHintOff,
  HINT_TAG,
  HINT_NOTE,
  MAX_BLOCK_CHARS,
} from "../plugin/hint.mjs";
import { discoverSkills } from "../core/sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX_ROOT = path.join(HERE, "fixtures", "root");

/** Fake `context` event: one system part + a message history ending in a user message. */
function makeEvent(text, { agent = "tester" } = {}) {
  const messages = [{ role: "assistant", content: [{ type: "text", text: "earlier reply" }] }];
  if (text !== undefined) messages.push({ role: "user", content: [{ type: "text", text }] });
  return {
    agent,
    system: [{ type: "text", text: "preamble part" }],
    messages,
  };
}

function newHook(overrides = {}) {
  return createContextHook({ env: {}, roots: [FIX_ROOT], debug: false, ...overrides });
}

function entryLines(block) {
  return block.split("\n").filter((l) => l.startsWith("- "));
}

function entryNames(block) {
  return entryLines(block).map((l) => l.slice(2).split(":")[0]);
}

const HINT_TAG_LITERAL = '<skill_hint source="skill-router" note="подсказка, не загрузка: скилл не открыт">';

// ── формат блока (R1, R6) ───────────────────────────────────────────────────

test("format: one text part, exact note, <=2 entries, <=1000 chars", () => {
  const ev = makeEvent("zebra operations");
  newHook()(ev);
  assert.equal(ev.system.length, 2, "exactly one part appended");
  const part = ev.system[1];
  assert.equal(part.type, "text");
  const block = part.text;

  // R1 verbatim: the note attribute is exact, the tag matches spec §7.
  assert.equal(block.split("\n")[0], HINT_TAG);
  assert.equal(HINT_TAG, HINT_TAG_LITERAL);
  assert.equal(HINT_NOTE, "подсказка, не загрузка: скилл не открыт");
  assert.equal(block.split("\n").at(-1), "</skill_hint>");
  assert.equal(block.split("<skill_hint").length - 1, 1, "single opening tag");
  assert.equal(block.split("</skill_hint>").length - 1, 1, "single closing tag");

  const entries = entryLines(block);
  assert.ok(entries.length >= 1 && entries.length <= 2, `entries: ${entries.length}`);
  assert.ok(block.length <= MAX_BLOCK_CHARS, `block ${block.length} chars`);
  assert.ok(block.length <= 1000);
  for (const line of entries) {
    const m = /^- (skill-[a-z]+): ([^;\n]+); открыть: инструмент skill, name=(skill-[a-z]+)$/.exec(line);
    assert.ok(m, `bad entry line: ${line}`);
    assert.equal(m[1], m[3], "name repeats in the open instruction");
    assert.ok(m[2].length <= 200, "why line ≤200 chars");
  }
  for (const name of entryNames(block)) {
    assert.ok(["skill-delta", "skill-omega"].includes(name), `unexpected skill ${name}`);
  }
  assert.equal(entries.length, 2, "zebra matches both delta and omega — cap holds at 2");
});

test("buildHintBlock: empty input → empty block", () => {
  assert.equal(buildHintBlock([]), "");
  assert.equal(buildHintBlock(null), "");
  assert.equal(buildHintBlock([{ name: "x", why: "" }]), "");
});

test("entry text cannot fake or break the <skill_hint> envelope", () => {
  const block = buildHintBlock([
    { name: "skill-evil", why: 'has </skill_hint> and <skill_hint source="x"> markers <b>plus</b> tags' },
    { name: "bad name: with separators", why: "must be skipped" },
  ]);
  assert.ok(block.length > 0);
  assert.equal(block.split("<skill_hint").length - 1, 1, "one opening tag");
  assert.equal(block.split("</skill_hint>").length - 1, 1, "one closing tag");
  assert.ok(!block.split("\n")[1].includes("<"), "why line has no angle brackets");
  assert.equal(entryLines(block).length, 1, "unsafe name skipped");
});

// ── нет текста / нет букв → подсказки нет ───────────────────────────────────

test("no hint: empty, whitespace, punctuation-only, digits-only, no user message", () => {
  for (const text of ["", "   \n\t  ", "!!! ... ---", "123 456 -- 78"]) {
    const ev = makeEvent(text);
    const before = structuredClone(ev.system);
    newHook()(ev);
    assert.deepEqual(ev.system, before, `no hint for ${JSON.stringify(text)}`);
  }
  const noUser = makeEvent(undefined);
  const beforeNoUser = structuredClone(noUser.system);
  newHook()(noUser);
  assert.deepEqual(noUser.system, beforeNoUser, "no user message → no hint");

  const mediaOnly = makeEvent(undefined);
  mediaOnly.messages.push({
    role: "user",
    content: [{ type: "media", mediaType: "image/png", data: "AAAA" }],
  });
  const beforeMedia = structuredClone(mediaOnly.system);
  newHook()(mediaOnly);
  assert.deepEqual(mediaOnly.system, beforeMedia, "user message without text → no hint");
});

// ── выключение env (AC7, R6) ────────────────────────────────────────────────

test("SKILL_ROUTER_HINT=off|0|false → no hint (any case)", () => {
  for (const value of ["off", "0", "false", "OFF", " False "]) {
    const ev = makeEvent("zebra operations");
    const before = structuredClone(ev.system);
    newHook({ env: { SKILL_ROUTER_HINT: value } })(ev);
    assert.deepEqual(ev.system, before, `SKILL_ROUTER_HINT=${JSON.stringify(value)} must disable`);
  }
  assert.equal(isHintOff("off"), true);
  assert.equal(isHintOff("0"), true);
  assert.equal(isHintOff("false"), true);
  assert.equal(isHintOff("on"), false);
  assert.equal(isHintOff(undefined), false);
  const on = makeEvent("zebra operations");
  newHook({ env: { SKILL_ROUTER_HINT: "on" } })(on);
  assert.equal(on.system.length, 2, "any other value keeps the hint enabled");
});

// ── deny / allow по агенту (R2) ─────────────────────────────────────────────

test("deny: forbidden skill never enters the block", () => {
  const config = { deny: { tester: ["skill-delta"] }, allow: {} };
  const ev = makeEvent("zebra operations");
  newHook({ config })(ev);
  assert.equal(ev.system.length, 2);
  assert.deepEqual(entryNames(ev.system[1].text), ["skill-omega"]);
  assert.ok(!ev.system[1].text.includes("skill-delta"), "denied skill must be absent");
});

test("deny for an agent does not affect other agents (default = hint all)", () => {
  const config = { deny: { tester: ["skill-beta", "skill-delta", "skill-omega"] }, allow: {} };
  const blocked = makeEvent("banana zebra manual");
  newHook({ config })(blocked);
  assert.equal(blocked.system.length, 1, "tester is denied every match → no hint");

  const other = makeEvent("banana zebra manual", { agent: "other-agent" });
  newHook({ config })(other);
  assert.equal(other.system.length, 2, "unconfigured agent keeps the default");
  assert.equal(entryNames(other.system[1].text).length, 2);
});

test("allow: only listed skills are hinted; agent without allow is unrestricted", () => {
  const config = { deny: {}, allow: { tester: ["skill-beta"] } };
  // M7 coverage: «banana split» is N=2 and skill-beta covers both tokens.
  const tester = makeEvent("banana split");
  newHook({ config })(tester);
  assert.equal(tester.system.length, 2);
  assert.deepEqual(entryNames(tester.system[1].text), ["skill-beta"]);

  // M7 coverage: of «banana zebra manual» (N=3) skill-beta covers only
  // «banana» — one token proves nothing — so only the two skills covering
  // «zebra»+«manual» remain, and the default (no allow) hints those two.
  const other = makeEvent("banana zebra manual", { agent: "other-agent" });
  newHook({ config })(other);
  assert.equal(entryNames(other.system[1].text).length, 2, "2 of the 3 matches pass the coverage rule");
});

// ── fail-open (R6) ──────────────────────────────────────────────────────────

test("search throwing → hook does not throw, no hint, debug line to writer", () => {
  const lines = [];
  const hook = newHook({ search: () => { throw new Error("boom"); }, debug: (m) => lines.push(m) });
  const ev = makeEvent("zebra operations");
  const before = structuredClone(ev.system);
  assert.doesNotThrow(() => hook(ev));
  assert.deepEqual(ev.system, before);
  assert.ok(lines.some((l) => l.includes("fail-open") && l.includes("boom")), `lines: ${JSON.stringify(lines)}`);
});

test("index build throwing → hook does not throw, no hint, no rebuild storm", () => {
  const lines = [];
  let builds = 0;
  const hook = newHook({
    discover: () => { builds += 1; throw new Error("roots gone"); },
    debug: (m) => lines.push(m),
  });
  const ev = makeEvent("zebra operations");
  const before = structuredClone(ev.system);
  assert.doesNotThrow(() => hook(ev));
  assert.doesNotThrow(() => hook(ev));
  assert.deepEqual(ev.system, before);
  assert.equal(builds, 1, "failed build is cached, not retried");
  assert.ok(lines.some((l) => l.includes("index build failed") && l.includes("roots gone")));
});

test("broken index search result (non-array) does not crash the hook", () => {
  const hook = newHook({ search: () => null });
  const ev = makeEvent("zebra operations");
  const before = structuredClone(ev.system);
  assert.doesNotThrow(() => hook(ev));
  assert.deepEqual(ev.system, before);
});

// ── одна часть, в конце system, сообщения не тронуты ────────────────────────

test("exactly one part at the end of system; original parts, messages untouched", () => {
  const ev = makeEvent("zebra operations");
  ev.system.push({ type: "text", text: "second original part" });
  const sysBefore = structuredClone(ev.system);
  const msgBefore = structuredClone(ev.messages);
  newHook()(ev);
  assert.equal(ev.system.length, sysBefore.length + 1, "exactly one part added");
  assert.deepEqual(ev.system.slice(0, -1), sysBefore, "original parts unchanged");
  assert.equal(ev.system.at(-1).type, "text");
  assert.ok(ev.system.at(-1).text.startsWith("<skill_hint"), "hint is the last part");
  assert.deepEqual(ev.messages, msgBefore, "messages untouched");
});

test("second call on the same event does not duplicate the block (idempotent)", () => {
  const hook = newHook();
  const ev = makeEvent("zebra operations");
  hook(ev);
  hook(ev);
  assert.equal(ev.system.length, 2, "still exactly one appended part");
  assert.equal(ev.system.at(-1).text.split("<skill_hint").length - 1, 1);
});

// ── блок не утверждает загрузку (R1) ────────────────────────────────────────

test("block never claims a skill is loaded/opened (except the mandated note + open instruction)", () => {
  const ev = makeEvent("zebra operations");
  newHook()(ev);
  const block = ev.system.at(-1).text;
  const scrubbed = block
    .replace(/note="[^"]*"/, "") // R1-mandated note attribute
    .replace(/открыть: инструмент skill/g, ""); // §7-mandated open instruction
  assert.ok(!/загружен/i.test(scrubbed), "no «загружен»");
  assert.ok(!/открыт/i.test(scrubbed), "no «открыт» outside the note");
  assert.ok(!/loaded/i.test(scrubbed), "no «loaded»");
  // The note itself is verbatim and claims the opposite:
  assert.ok(block.includes('note="подсказка, не загрузка: скилл не открыт"'));
});

// ── кэш индекса и бюджет времени ────────────────────────────────────────────

test("index is built once per hook instance (once per opencode process)", () => {
  let builds = 0;
  const hook = newHook({ discover: (roots) => { builds += 1; return discoverSkills(roots); } });
  hook(makeEvent("zebra operations"));
  hook(makeEvent("banana split"));
  hook(makeEvent("zebra operations"));
  assert.equal(builds, 1);
});

test("formation >150 ms → hint dropped and reported to debug", () => {
  const lines = [];
  let calls = 0;
  const hook = newHook({ now: () => (calls++ === 0 ? 0 : 151), debug: (m) => lines.push(m) });
  const ev = makeEvent("zebra operations");
  const before = structuredClone(ev.system);
  hook(ev);
  assert.deepEqual(ev.system, before, "over-budget hint must not be appended");
  assert.ok(lines.some((l) => l.includes("took 151.0 ms") && l.includes("150 ms")), `lines: ${JSON.stringify(lines)}`);
});

test("formation exactly 150 ms → hint appended (limit is >150)", () => {
  let calls = 0;
  const hook = newHook({ now: () => (calls++ === 0 ? 0 : 150) });
  const ev = makeEvent("zebra operations");
  hook(ev);
  assert.equal(ev.system.length, 2, "150 ms is within budget");
});

// ── конфиг: отсутствие и порча не ломают (fail-open) ────────────────────────

test("missing config file → default behaviour, hint still works", () => {
  const ev = makeEvent("zebra operations");
  newHook({ configPath: path.join(HERE, "no-such-config.json") })(ev);
  assert.equal(ev.system.length, 2, "missing config is not an error");
});

test("malformed config file → defaults + debug line, hint still works", () => {
  const tmp = path.join(os.tmpdir(), `skill-router-test-${process.pid}.config.json`);
  fs.writeFileSync(tmp, "{ not json", "utf8");
  try {
    const lines = [];
    const ev = makeEvent("zebra operations");
    newHook({ configPath: tmp, debug: (m) => lines.push(m) })(ev);
    assert.equal(ev.system.length, 2, "malformed config falls back to defaults");
    assert.ok(lines.some((l) => l.includes("malformed")), `lines: ${JSON.stringify(lines)}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// ── v0.3: подсказка строится только из confident:true ───────────────────────

test("v0.3: only confident positions enter the block (mixed pool)", () => {
  // «banana split zebra» (N=3): skill-beta covers banana+split (confident),
  // delta/omega cover «zebra» alone (not confident) — the block must contain
  // beta only, even though all three are in the raw result list.
  const ev = makeEvent("banana split zebra");
  newHook()(ev);
  assert.equal(ev.system.length, 2, "a confident candidate exists → the block forms");
  assert.deepEqual(entryNames(ev.system[1].text), ["skill-beta"]);
  assert.ok(!ev.system[1].text.includes("skill-delta"), "a non-confident position must never be hinted");
  assert.ok(!ev.system[1].text.includes("skill-omega"), "a non-confident position must never be hinted");
});

test("v0.3: raw hits but no confident position → no block", () => {
  const ev = makeEvent("banana zebra");
  const before = structuredClone(ev.system);
  newHook()(ev);
  assert.deepEqual(ev.system, before, "search finds something, the hint still stays silent");
});

// Phase 1a (owner task 28.10.2026, «product-skill-mcp-router-20261028»), phase
// 2 «усилить правило» (owner decision 28.10.2026): the ALWAYS-ON ROUTER RULE
// (`<skill_router_rule>`) is UNSHIFTED to the FRONT of `system`, fires even
// under tool-silence (silence gates the hint only) and before the
// preload/hint, the off-switches. All tests run on FAKE discover/buildIndex/
// search — no live skill corpus, no files.
import test from "node:test";
import assert from "node:assert/strict";
import { createContextHook, normalizeConfig, isToolSilent, ROUTER_RULE, RULE_MARKER } from "../plugin/hint.mjs";

/** Fake skill records (in-memory paths; preload finds no file → fail-open). */
function s(name, description) {
  return { name, path: `C:/x/${name}/SKILL.md`, root: "C:/x", description, bodyHeadings: [] };
}

const SKILLS = [s("skill-alpha", "Alpha does alpha operations."), s("skill-beta", "Beta does beta operations.")];

/** Fake search: confident candidates / a pool with no confident position. */
const confidentSearch = () => [
  { name: "skill-alpha", path: "C:/x/skill-alpha/SKILL.md", score: 10, confident: true },
  { name: "skill-beta", path: "C:/x/skill-beta/SKILL.md", score: 5, confident: true },
];
const noConfidentSearch = () => [{ name: "skill-alpha", path: "C:/x/skill-alpha/SKILL.md", score: 1, confident: false }];

const HINT_MARKER = '<skill_hint source="skill-mcp"';

/** Fake `context` event: preamble part + a user message. */
function makeEvent(text) {
  return {
    agent: "tester",
    system: [{ type: "text", text: "preamble part" }],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

/** Hermetic hook: fakes for every core entrypoint, in-memory config. */
function newHook(overrides = {}) {
  const { env, ...rest } = overrides;
  return createContextHook({
    env: env ?? {},
    debug: false,
    config: { rule: true, deny: {}, allow: {} },
    discover: () => ({ skills: SKILLS }),
    buildIndex: (skills) => skills,
    search: confidentSearch,
    ...rest,
  });
}

test("phase 2: rule verbatim, exactly once, FIRST in system (unshift); hint stays the last part; idempotent", () => {
  // The rule text is verbatim (owner task phase 1a, strengthened phase 2),
  // marker on both edges, ≤500 chars.
  assert.equal(ROUTER_RULE.split("\n")[0], RULE_MARKER);
  assert.equal(RULE_MARKER, "<skill_router_rule>");
  assert.equal(ROUTER_RULE.split("\n").at(-1), "</skill_router_rule>");
  assert.ok(ROUTER_RULE.length <= 500, `rule ${ROUTER_RULE.length} chars <= 500`);
  assert.ok(ROUTER_RULE.includes("Первое действие в задаче — вызови find сервера skill-mcp"), "find-first line");
  assert.ok(ROUTER_RULE.includes("не начинай правки, проверки и содержательные ответы"), "no-work-before-find line");
  assert.ok(ROUTER_RULE.includes("скрытые из каталога скиллы тоже доступны через find"), "hidden skills line");
  assert.ok(ROUTER_RULE.includes("«автосовпадения нет»"), "no-auto-match line");
  assert.ok(ROUTER_RULE.includes("Пропуск = задача не выполнена."), "mandatory line");

  const hook = newHook();
  const ev = makeEvent("zebra operations manual");
  hook(ev);

  const ruleParts = ev.system.filter((p) => p && typeof p.text === "string" && p.text.includes(RULE_MARKER));
  assert.equal(ruleParts.length, 1, "rule exactly once");
  assert.equal(ruleParts[0].text, ROUTER_RULE, "rule part is the verbatim text");
  assert.ok(ev.system[0].text.includes(RULE_MARKER), "rule is the FIRST part of system (unshift)");
  const hintIdx = ev.system.findIndex((p) => p.text.includes(HINT_MARKER));
  assert.ok(hintIdx > 0, "hint forms for a confident pool");
  assert.ok(ev.system.at(-1).text.includes(HINT_MARKER), "hint is the last part");

  const before = ev.system.length;
  hook(ev); // same event again — nothing may be appended
  assert.equal(ev.system.length, before, "second call appends nothing (idempotent)");
});

test("phase 2: rule is added even when there is NO confident candidate", () => {
  const ev = makeEvent("что-нибудь зебра операции");
  newHook({ search: noConfidentSearch })(ev);

  assert.equal(ev.system.length, 2, "rule + preamble only — no hint block");
  assert.ok(ev.system[0].text.includes(RULE_MARKER), "rule present (first) without a confident pool");
  assert.ok(!ev.system.some((p) => p && typeof p.text === "string" && p.text.includes(HINT_MARKER)), "no hint");
});

test("phase 1a: SKILL_MCP_RULE=off removes ONLY the rule; SKILL_MCP_HINT=off removes both", () => {
  const ev = makeEvent("zebra operations manual");
  newHook({ env: { SKILL_MCP_RULE: "off" } })(ev);
  assert.ok(!ev.system.some((p) => p && typeof p.text === "string" && p.text.includes(RULE_MARKER)), "rule disabled");
  assert.ok(ev.system.some((p) => p && typeof p.text === "string" && p.text.includes(HINT_MARKER)), "hint stays");

  const ev2 = makeEvent("zebra operations manual");
  newHook({ env: { SKILL_MCP_HINT: "off" } })(ev2);
  assert.equal(ev2.system.length, 1, "hint switch off: neither rule nor hint");
});

test("phase 2: cyrillic tool-silence — rule IS added (first), hint is NOT; idempotent", () => {
  const msg = "а почему ты сейчас не применил скилы нужные? у тебя же подключен скилл мцп";
  assert.equal(isToolSilent(msg), true, "cyrillic tool word + complaint = tool-silent");

  const hook = newHook(); // confident fakes would build a hint if the silence failed
  const ev = makeEvent(msg);
  hook(ev);
  assert.equal(ev.system.length, 2, "silence: rule + preamble only — no hint");
  assert.ok(ev.system[0].text.includes(RULE_MARKER), "rule is added FIRST even under tool-silence");
  assert.ok(!ev.system.some((p) => p && typeof p.text === "string" && p.text.includes(HINT_MARKER)), "hint suppressed by tool-silence");

  const before = ev.system.length;
  hook(ev);
  assert.equal(ev.system.length, before, "second call appends nothing (idempotent under silence)");
});

test("phase 1a: config rule:false disables the rule; a set env SKILL_MCP_RULE wins over config", () => {
  assert.equal(normalizeConfig({ rule: false }).rule, false);
  assert.equal(normalizeConfig({}).rule, true, "default on");
  assert.equal(normalizeConfig(null).rule, true, "junk → default on");

  const ev = makeEvent("zebra operations manual");
  newHook({ config: { rule: false, deny: {}, allow: {} } })(ev);
  assert.ok(!ev.system.some((p) => p && typeof p.text === "string" && p.text.includes(RULE_MARKER)), "config off: no rule");
  assert.ok(ev.system.some((p) => p && typeof p.text === "string" && p.text.includes(HINT_MARKER)), "hint stays");

  const ev2 = makeEvent("zebra operations manual");
  newHook({ config: { rule: false, deny: {}, allow: {} }, env: { SKILL_MCP_RULE: "on" } })(ev2);
  assert.ok(ev2.system.some((p) => p && typeof p.text === "string" && p.text.includes(RULE_MARKER)), "env wins over config");
});

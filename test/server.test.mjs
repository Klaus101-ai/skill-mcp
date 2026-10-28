// MCP server tests: spawn server/index.mjs as a child process, speak
// newline-delimited JSON-RPC 2.0 over stdio, then close stdin and assert the
// server exits on EOF. Requests carry a 10s timeout so nothing can hang.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { extractHeadingEntries, discoverSkills } from "../core/sources.mjs";
import { tmpDir, isolatedEnv, seedSkillsHome, HOME_SKILL_RELS } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT = path.join(HERE, "..");
const SERVER = path.join(PRODUCT, "server", "index.mjs");

// Isolation (incident 26.10.2026): the server children must never resolve the
// REAL home. These tests were written against the real skill corpus, so the
// corpus (SKILL.md files only) is snapshotted once into a temp home and both
// the parent-side discovery and every child use that snapshot.
const CORPUS_HOME = tmpDir("serverhome");
seedSkillsHome(CORPUS_HOME);
const CORPUS_ROOTS = HOME_SKILL_RELS.map((rel) => path.join(CORPUS_HOME, rel)).filter((p) => fs.existsSync(p));
after(() => fs.rmSync(CORPUS_HOME, { recursive: true, force: true }));

function startServer(home = CORPUS_HOME) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: PRODUCT,
    env: isolatedEnv(home),
  });
  const pending = new Map();
  const badLines = [];
  const unsolicited = [];
  const unsolicitedWaiters = [];
  let stderrBuf = "";
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === "") continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        badLines.push(line);
        continue;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      } else if (unsolicitedWaiters.length > 0) {
        unsolicitedWaiters.shift()(msg);
      } else {
        unsolicited.push(msg);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderrBuf += d;
  });

  let nextId = 1;
  const write = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

  return {
    child,
    badLines,
    unsolicited,
    stderr: () => stderrBuf,
    nextUnsolicited() {
      if (unsolicited.length > 0) return Promise.resolve(unsolicited.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout: no unsolicited response")), 10000);
        unsolicitedWaiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    request(method, params) {
      const id = nextId++;
      write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout: no response for ${method}`));
        }, 10000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    },
    raw(line) {
      child.stdin.write(`${line}\n`);
    },
    async shutdown() {
      child.stdin.end();
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve("TIMEOUT"), 10000);
        child.on("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      if (code === "TIMEOUT") {
        child.kill();
        throw new Error("server did not exit on stdin EOF");
      }
      return code;
    },
  };
}

function payloadOf(response) {
  assert.ok(response.result, `expected a result: ${JSON.stringify(response)}`);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");
  return JSON.parse(response.result.content[0].text);
}

// A real skill from the real roots that has at least two headings.
function pickSkill() {
  const { skills } = discoverSkills(CORPUS_ROOTS);
  for (const s of [...skills].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    try {
      const text = fs.readFileSync(s.path, "utf8");
      const entries = extractHeadingEntries(text);
      if (entries.length >= 2) return { skill: s, entries };
    } catch {
      // unreadable file: pick another
    }
  }
  throw new Error("no skill with >=2 headings found in the default roots");
}

test("MCP: initialize, initialized, ping, tools/list, unknown method/tool, exit on EOF", async () => {
  const s = startServer();
  try {
    const init = await s.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "node-test", version: "1.0.0" },
    });
    assert.equal(init.result.protocolVersion, "2025-11-25");
    assert.ok(init.result.capabilities.tools, "tools capability must be declared");
    assert.equal(init.result.serverInfo.name, "skill-mcp");
    assert.ok(init.result.serverInfo.version);

    s.notify("notifications/initialized");

    const ping = await s.request("ping");
    assert.deepEqual(ping.result, {});

    const list = await s.request("tools/list");
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["find", "outline", "read-section"]);
    for (const t of list.result.tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.ok(typeof t.description === "string" && t.description.length > 0);
    }
    // v0.4.1 (G): find default limit is 10 (max stays 10)
    const findSchema = list.result.tools.find((t) => t.name === "find");
    assert.equal(findSchema.inputSchema.properties.limit.default, 10, "v0.4.1: default limit 10");
    assert.equal(findSchema.inputSchema.properties.limit.maximum, 10, "max limit 10");
    // v0.6.2 (owner task 27.10.2026): the description must lead with the
    // call-first instruction and tell the agent to COMPARE descriptions and
    // LOAD the matching skill — the old self-service clause is gone.
    assert.equal(findSchema.name, "find", "the tool keeps its name");
    assert.ok(findSchema.description.startsWith("Call this FIRST"), "description leads with «Call this FIRST»");
    assert.ok(findSchema.description.includes("Read the descriptions"), "description says to read the descriptions");
    assert.ok(
      findSchema.description.includes("Load the chosen skill with the skill tool"),
      "description says to load the chosen skill",
    );
    assert.ok(
      findSchema.description.includes("if no candidate matches, proceed without a skill"),
      "description covers the no-match branch",
    );
    assert.ok(
      !findSchema.description.includes("the agent's model chooses"),
      "the removed «the agent's model chooses» clause must be gone",
    );

    const unknownMethod = await s.request("no/such/method");
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = await s.request("tools/call", { name: "nope", arguments: {} });
    assert.equal(unknownTool.error.code, -32602);
    assert.match(unknownTool.error.message, /nope/);

    // malformed JSON -> -32700 with a null id, still one JSON-RPC line
    s.raw("{not json");
    const parseError = await s.nextUnsolicited();
    assert.equal(parseError.error.code, -32700);
    assert.equal(parseError.id, null);

    // request without a method -> -32600, id echoed
    s.raw(JSON.stringify({ jsonrpc: "2.0", id: 5, params: {} }));
    const invalidRequest = await s.nextUnsolicited();
    assert.equal(invalidRequest.error.code, -32600);
    assert.equal(invalidRequest.id, 5);

    const code = await s.shutdown();
    assert.equal(code, 0, "server must exit with 0 on stdin EOF");
    assert.deepEqual(s.badLines, [], "stdout must contain JSON-RPC lines only");
  } finally {
    if (s.child.exitCode === null) s.child.kill();
  }
});

test("MCP: find / outline / read-section contracts and validation", async () => {
  const s = startServer();
  try {
    await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "node-test", version: "1.0.0" } });
    s.notify("notifications/initialized");

    const { skill, entries } = pickSkill();

    // find: happy path
    const hit = await s.request("tools/call", { name: "find", arguments: { query: skill.name, limit: 3 } });
    const hitPayload = payloadOf(hit);
    assert.equal(hitPayload.ok, true);
    assert.ok(Array.isArray(hitPayload.items) && hitPayload.items.length >= 1);
    assert.equal(hit.result.isError, false);
    for (const item of hitPayload.items) {
      assert.ok(typeof item.name === "string");
      assert.ok(typeof item.score === "number");
      assert.ok(item.why.length <= 160);
      assert.equal(typeof item.description, "string", "v0.4: every item carries the skill description");
      assert.equal(typeof item.confident, "boolean", "v0.3: every item carries the confident flag");
    }
    // v0.3: a query equal to a skill name always proves that skill -> at least
    // one confident position, so no `note` is attached.
    assert.ok(hitPayload.items.some((i) => i.confident === true), "skill-name query must yield a confident hit");
    assert.ok(!("note" in hitPayload), `no note when a confident position exists: ${JSON.stringify(hitPayload)}`);
    // v0.6.2: a non-empty result carries a top-level `next` telling the agent
    // what to do — a confident FIRST item names it as the likely match.
    const expectedNext =
      hitPayload.items[0].confident === true
        ? `likely match: ${hitPayload.items[0].name} — verify its description and load it`
        : "review the candidate descriptions; load the matching skill";
    assert.equal(hitPayload.next, expectedNext, `v0.6.2: top-level next: ${JSON.stringify(hitPayload.next)}`);
    if (hitPayload.items[0].confident === true) {
      assert.ok(
        hitPayload.next.startsWith(`likely match: ${hitPayload.items[0].name} —`),
        "confident head → likely-match next with the name",
      );
    }
    // v0.4: the item of the queried skill carries the skill's description.
    const self = hitPayload.items.find((i) => i.name === skill.name);
    assert.ok(self, "the queried skill must be among the candidates");
    assert.equal(self.description, skill.description, "v0.4: description travels with the item");

    // v0.4.1 (G): no explicit limit → up to 10 items (default limit 10).
    // The promo assertions apply to a host where the real `promo` skill is
    // installed (same guard pattern as the supply-contract-review test); the
    // corpus-independent G behaviour (default 10, boost mechanics) is covered
    // by test/candidates.test.mjs on the in-memory fixture.
    const defLimit = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: "описание продукта" } }),
    );
    assert.equal(defLimit.ok, true);
    assert.ok(Array.isArray(defLimit.items) && defLimit.items.length > 5, `default limit 10 expected >5 items, got ${defLimit.items.length}`);
    assert.ok(defLimit.items.length <= 10, `never above MAX_LIMIT: ${defLimit.items.length}`);
    // v0.6.2: any non-empty result carries `next`, in exactly one of the two
    // documented forms (the likely-match one is keyed off the first item).
    const head = defLimit.items[0];
    assert.equal(
      defLimit.next,
      head.confident === true
        ? `likely match: ${head.name} — verify its description and load it`
        : "review the candidate descriptions; load the matching skill",
      "v0.6.2: `next` follows the confidence of the first item",
    );
    const { skills: realSkills } = discoverSkills(CORPUS_ROOTS);
    if (realSkills.some((s) => s.name === "promo")) {
      // «описание продукта» carries both boost triggers («описан», «продукт»),
      // so the domain boost raises promo to the top of the returned pool.
      const promoPos = defLimit.items.findIndex((i) => i.name === "promo") + 1;
      assert.equal(promoPos, 1, `G: promo must lead the default find: ${defLimit.items.map((i) => i.name).join(", ")}`);
    }
    // explicit limit still caps
    const lim3 = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: "описание продукта", limit: 3 } }),
    );
    assert.ok(lim3.items.length <= 3, "explicit limit is honoured");

    // find: empty query
    const empty = payloadOf(await s.request("tools/call", { name: "find", arguments: { query: "" } }));
    assert.deepEqual(empty, { ok: true, items: [], note: "пустой запрос" });

    // find: junk query — its meaningful tokens occur in no skill text, but
    // v0.3 search is NOT gated: the raw matches are returned with
    // confident:false and only the note reports that nothing is confident.
    const noMatch = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: "Как сварить борщ с говядиной" } }),
    );
    assert.equal(noMatch.ok, true);
    assert.ok(Array.isArray(noMatch.items) && noMatch.items.length > 0, "v0.3: the full list is returned");
    assert.ok(
      noMatch.items.every((i) => i.confident === false),
      `no position may be confident: ${JSON.stringify(noMatch.items.map((i) => i.name))}`,
    );
    assert.equal(noMatch.note, "уверенных нет, вот возможные");
    // v0.6.2: nothing is confident, so `next` is the review-descriptions form
    // (the likely-match form is reserved for a confident first item).
    assert.equal(
      noMatch.next,
      "review the candidate descriptions; load the matching skill",
      "v0.6.2: non-confident result → generic next",
    );

    // find: a query nothing matches at all still answers the empty form
    const noHits = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: "qqqzzzxyw nonexistenttoken" } }),
    );
    assert.deepEqual(noHits, { ok: true, items: [], note: "ничего не найдено" });

    // find: validation
    const noQuery = payloadOf(await s.request("tools/call", { name: "find", arguments: {} }));
    assert.equal(noQuery.ok, false);
    assert.equal(noQuery.error.code, "E_INVALID_INPUT");

    const numQuery = payloadOf(await s.request("tools/call", { name: "find", arguments: { query: 42 } }));
    assert.equal(numQuery.error.code, "E_INVALID_INPUT");

    const bigLimit = await s.request("tools/call", { name: "find", arguments: { query: "test", limit: 99 } });
    const bigLimitPayload = payloadOf(bigLimit);
    assert.equal(bigLimitPayload.error.code, "E_INVALID_INPUT");
    assert.equal(bigLimit.result.isError, true);

    const zeroLimit = payloadOf(await s.request("tools/call", { name: "find", arguments: { query: "test", limit: 0 } }));
    assert.equal(zeroLimit.error.code, "E_INVALID_INPUT");

    const badRestrict = payloadOf(await s.request("tools/call", { name: "find", arguments: { query: "test", restrict_to: "bugbounty" } }));
    assert.equal(badRestrict.error.code, "E_INVALID_INPUT");

    const badRestrictItem = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: "test", restrict_to: [1] } }),
    );
    assert.equal(badRestrictItem.error.code, "E_INVALID_INPUT");

    // outline by name
    const outline = payloadOf(await s.request("tools/call", { name: "outline", arguments: { name: skill.name } }));
    assert.equal(outline.ok, true);
    assert.equal(outline.name, skill.name);
    assert.equal(outline.path, skill.path);
    assert.equal(typeof outline.description, "string");
    assert.ok(outline.headings.length >= 1 && outline.headings.length <= 40);
    for (const h of outline.headings) {
      assert.ok([1, 2, 3, 4, 5, 6].includes(h.level));
      assert.ok(typeof h.line === "number" && h.line >= 1);
    }
    assert.ok(!( "truncated" in outline) || outline.truncated === false || outline.truncated === true);

    // outline by path (inside a real root)
    const outlineByPath = payloadOf(await s.request("tools/call", { name: "outline", arguments: { path: skill.path } }));
    assert.equal(outlineByPath.ok, true);
    assert.equal(outlineByPath.path, skill.path);

    // outline: invalid input / not found / forbidden
    const outlineMissing = payloadOf(await s.request("tools/call", { name: "outline", arguments: {} }));
    assert.equal(outlineMissing.error.code, "E_INVALID_INPUT");

    const outlineUnknown = payloadOf(
      await s.request("tools/call", { name: "outline", arguments: { name: "definitely-not-a-skill-xyz" } }),
    );
    assert.equal(outlineUnknown.error.code, "E_NOT_FOUND");

    const outlineEscaping = await s.request("tools/call", { name: "outline", arguments: { path: "C:\\Windows\\win.ini" } });
    const outlineEscapingPayload = payloadOf(outlineEscaping);
    assert.equal(outlineEscapingPayload.error.code, "E_FORBIDDEN");
    assert.equal(outlineEscaping.result.isError, true);

    // read-section by heading text
    const want = entries[0];
    const section = payloadOf(
      await s.request("tools/call", { name: "read-section", arguments: { name: skill.name, heading: want.text } }),
    );
    assert.equal(section.ok, true);
    assert.equal(section.heading, want.text);
    assert.equal(section.line_start, want.line);
    assert.equal(typeof section.truncated, "boolean");
    assert.ok(section.lines.length >= 1);
    assert.equal(section.lines[0], fs.readFileSync(skill.path, "utf8").split(/\r?\n/)[want.line - 1]);

    // read-section by 1-based number
    const byNumber = payloadOf(
      await s.request("tools/call", { name: "read-section", arguments: { name: skill.name, heading: 1 } }),
    );
    assert.equal(byNumber.ok, true);
    assert.equal(byNumber.heading, entries[0].text);

    // read-section: heading with a leading '#'
    const withHash = payloadOf(
      await s.request("tools/call", { name: "read-section", arguments: { name: skill.name, heading: `# ${want.text}` } }),
    );
    assert.equal(withHash.ok, true);

    // read-section: not found / validation / limits
    const noSection = payloadOf(
      await s.request("tools/call", { name: "read-section", arguments: { name: skill.name, heading: "no such heading xyz" } }),
    );
    assert.equal(noSection.error.code, "E_SECTION_NOT_FOUND");

    const noHeading = payloadOf(
      await s.request("tools/call", { name: "read-section", arguments: { name: skill.name } }),
    );
    assert.equal(noHeading.error.code, "E_INVALID_INPUT");

    const bigMax = payloadOf(
      await s.request("tools/call", { name: "read-section", arguments: { name: skill.name, heading: 1, max_lines: 601 } }),
    );
    assert.equal(bigMax.error.code, "E_INVALID_INPUT");

    const tinyMax = payloadOf(
      await s.request("tools/call", { name: "read-section", arguments: { name: skill.name, heading: 1, max_lines: 1 } }),
    );
    assert.equal(tinyMax.ok, true);
    assert.ok(tinyMax.lines.length <= 1);

    const code = await s.shutdown();
    assert.equal(code, 0);
    assert.deepEqual(s.badLines, [], "stdout must contain JSON-RPC lines only");
  } finally {
    if (s.child.exitCode === null) s.child.kill();
  }
});

test("v0.6.2: find result carries `next` — likely match on a confident head, review-form otherwise, none when empty", async () => {
  const s = startServer();
  try {
    await s.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "node-test", version: "1.0.0" },
    });
    s.notify("notifications/initialized");

    // confident head: a query equal to a skill name proves that skill, and a
    // confident position always ranks first (v0.3.1 order) → likely-match form
    const { skill } = pickSkill();
    const confident = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: skill.name, limit: 3 } }),
    );
    assert.equal(confident.items[0].confident, true, "the queried skill leads its own query as confident");
    assert.equal(
      confident.next,
      `likely match: ${confident.items[0].name} — verify its description and load it`,
      "v0.6.2: confident head → likely-match next naming the skill",
    );

    // non-confident head: the junk query returns raw hits, all confident:false
    const junk = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: "Как сварить борщ с говядиной" } }),
    );
    assert.ok(junk.items.length > 0, "the junk query still returns the raw list");
    assert.ok(junk.items.every((i) => i.confident === false), "no position may be confident");
    assert.equal(
      junk.next,
      "review the candidate descriptions; load the matching skill",
      "v0.6.2: no confident head → review-descriptions next",
    );

    // empty results carry no `next` — there is nothing to review
    const empty = payloadOf(await s.request("tools/call", { name: "find", arguments: { query: "" } }));
    assert.deepEqual(empty, { ok: true, items: [], note: "пустой запрос" });
    const noHits = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: "qqqzzzxyw nonexistenttoken" } }),
    );
    assert.deepEqual(noHits, { ok: true, items: [], note: "ничего не найдено" });

    const code = await s.shutdown();
    assert.equal(code, 0);
    assert.deepEqual(s.badLines, [], "stdout must contain JSON-RPC lines only");
  } finally {
    if (s.child.exitCode === null) s.child.kill();
  }
});

test("MCP: outline caps at 40 headings and sets truncated:true", async () => {
  const { skills } = discoverSkills(CORPUS_ROOTS);
  let big = null;
  for (const s of skills) {
    try {
      const n = extractHeadingEntries(fs.readFileSync(s.path, "utf8")).length;
      if (n > 40) {
        big = { skill: s, total: n };
        break;
      }
    } catch {
      // unreadable: try the next one
    }
  }
  assert.ok(big, "expected at least one skill with >40 headings in the default roots");

  const s = startServer();
  try {
    await s.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "node-test", version: "1.0.0" } });
    s.notify("notifications/initialized");
    const outline = payloadOf(await s.request("tools/call", { name: "outline", arguments: { name: big.skill.name } }));
    assert.equal(outline.ok, true);
    assert.equal(outline.headings.length, 40, `expected the 40-heading cap, got ${outline.headings.length} of ${big.total}`);
    assert.equal(outline.truncated, true);
    const code = await s.shutdown();
    assert.equal(code, 0);
  } finally {
    if (s.child.exitCode === null) s.child.kill();
  }
});

// ── v0.6.3 (owner task 27.10.2026, item 3): find must be the VISIBLE tool ──
//
// The Code Mode catalog does NOT follow tools/list order: for every namespace
// it renders one listing line per tool and shows the CHEAPEST line first under
// a global cost budget (opencode bundle: L1 → f1 → round-robin, cost =
// Math.round(line.length / 4); line = "  - " + signature + " // " + the first
// description line capped at 120 chars; signature = the JSDoc-comment renderer
// behind the catalog's own `search`). find used to carry three property
// descriptions plus a 982-char first line → cost 115 vs outline's 76, so the
// catalog showed `outline`. The replica below re-derives that ranking from the
// LIVE tools/list payload; it was cross-checked against the signatures opencode
// itself published through catalog `search` on 27.10.2026 (333 / 174 / 322
// chars before this fix, find = 165 after it).
const CATALOG_SNIPPET_CAP = 120; // ys in the opencode renderer
const CATALOG_COST_DIVISOR = 4; // t1 in the opencode renderer

function schemaAnnotations(prop) {
  const out = [];
  if (prop.deprecated === true) out.push("@deprecated");
  if (prop.default !== undefined) {
    const json = JSON.stringify(prop.default);
    if (json !== undefined) out.push(`@default ${json}`);
  }
  if (typeof prop.format === "string") out.push(`@format ${prop.format}`);
  if (prop.type === "integer") out.push("@integer");
  if (typeof prop.minimum === "number") out.push(`@minimum ${prop.minimum}`);
  if (typeof prop.maximum === "number") out.push(`@maximum ${prop.maximum}`);
  if (typeof prop.minLength === "number") out.push(`@minLength ${prop.minLength}`);
  if (typeof prop.maxLength === "number") out.push(`@maxLength ${prop.maxLength}`);
  if (typeof prop.pattern === "string") out.push(`@pattern ${prop.pattern}`);
  return out.join(" ");
}

function propertyComment(prop, indent) {
  const annotations = schemaAnnotations(prop);
  let lines = (prop.description ?? "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 1) {
    const joined = `${lines[0]}${lines[0].endsWith(".") ? "" : "."} ${annotations}`.trimEnd();
    if (annotations && !annotations.includes("\n") && indent.length + joined.length + 7 <= CATALOG_SNIPPET_CAP) {
      lines = [joined];
    } else {
      lines = [...lines, ...(annotations ? annotations.split("\n") : [])];
    }
  } else {
    lines = [...lines, ...(annotations ? annotations.split("\n") : [])];
  }
  const clean = lines.map((l) => l.replaceAll("*/", "* /"));
  if (clean.length === 0) return "";
  if (clean.length === 1 && indent.length + clean[0].length + 7 <= CATALOG_SNIPPET_CAP) {
    return `${indent}/** ${clean[0]} */\n`;
  }
  const block = clean.map((l) => `${indent} *${l === "" ? "" : ` ${l}`}`).join("\n");
  return `${indent}/**\n${block}\n${indent} */\n`;
}

function renderType(prop) {
  if (typeof prop.type === "string") {
    if (prop.type === "array") return `Array<${renderType(prop.items ?? {})}>`;
    if (prop.type === "integer" || prop.type === "number") return "number";
    return prop.type;
  }
  if (Array.isArray(prop.type)) return prop.type.join(" | ");
  if (Array.isArray(prop.anyOf)) return prop.anyOf.map(renderType).join(" | ");
  return "unknown";
}

function catalogListing(tool) {
  const schema = tool.inputSchema ?? {};
  const required = new Set(schema.required ?? []);
  const indent = "  ";
  const params = Object.entries(schema.properties ?? {}).map(
    ([name, prop]) =>
      `${propertyComment(prop, indent)}${indent}${name}${required.has(name) ? "" : "?"}: ${renderType(prop)},`,
  );
  const body = params.length > 0 ? `{\n${params.join("\n")}\n}` : "{}";
  const id = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const lh =
    "tools" +
    `skill-mcp.${tool.name}`
      .split(".")
      .map((seg) => (id.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`))
      .join("");
  const signature = `${lh}(${body}): Promise<unknown>`;
  const first = (tool.description ?? "").split("\n", 1)[0]?.trim() ?? "";
  const snippet =
    first.length > CATALOG_SNIPPET_CAP ? `${first.slice(0, CATALOG_SNIPPET_CAP - 3)}...` : first;
  const line = `  - ${signature} // ${snippet}`;
  return { signature, line, cost: Math.round(line.length / CATALOG_COST_DIVISOR) };
}

test("v0.6.3: the Code Mode catalog shows find — tools/list order, instructions and line cost", async () => {
  const s = startServer();
  try {
    const init = await s.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "node-test", version: "1.0.0" },
    });
    s.notify("notifications/initialized");

    // the namespace line of the catalog is the server instructions — it must
    // lead with `find`
    assert.ok(
      init.result.instructions.startsWith("Read-only search over local SKILL.md files. Start with find"),
      `instructions: ${init.result.instructions}`,
    );

    const list = await s.request("tools/list");
    const tools = list.result.tools;
    assert.deepEqual(tools.map((t) => t.name), ["find", "outline", "read-section"], "find leads tools/list");

    const find = tools.find((t) => t.name === "find");
    // the catalog renders ONLY the first description line (≤120 chars)
    const firstLine = find.description.split("\n", 1)[0];
    assert.ok(firstLine.length <= CATALOG_SNIPPET_CAP, `first line is ${firstLine.length} chars, cap ${CATALOG_SNIPPET_CAP}`);
    // v0.6.2 clauses survive the rewrite (owner-pinned wording)
    assert.ok(find.description.startsWith("Call this FIRST"), "leads with «Call this FIRST»");
    assert.ok(find.description.includes("Read the descriptions"), "says to read the descriptions");
    assert.ok(find.description.includes("Load the chosen skill with the skill tool"), "says to load the skill");
    assert.ok(find.description.includes("if no candidate matches, proceed without a skill"), "covers the no-match branch");
    assert.ok(!find.description.includes("the agent's model chooses"), "the removed clause stays gone");
    // v0.6.3 confidence wording travels with the tool
    assert.ok(find.description.includes("need = 1 for a 1-2 token query"), "documents the new need rule");

    // the decisive assertion: find's listing line is the cheapest of the three
    const costs = tools.map((t) => ({ name: t.name, cost: catalogListing(t).cost }));
    const cheapest = [...costs].sort((a, b) => a.cost - b.cost || (a.name < b.name ? -1 : 1))[0];
    assert.equal(cheapest.name, "find", `find must be the cheapest listing line: ${JSON.stringify(costs)}`);
    const findCost = costs.find((c) => c.name === "find").cost;
    for (const other of costs.filter((c) => c.name !== "find")) {
      assert.ok(findCost < other.cost, `find (${findCost}) strictly below ${other.name} (${other.cost})`);
    }
    // sanity of the replica against the shape it replicates: find's schema keeps
    // its validation fields even though the property descriptions are gone
    const limit = find.inputSchema.properties.limit;
    assert.equal(limit.default, 10, "default stays (v0.4.1)");
    assert.equal(limit.maximum, 10, "maximum stays");
    assert.equal(limit.minimum, 1, "minimum stays");
    assert.deepEqual(find.inputSchema.required, ["query"], "required stays");

    const code = await s.shutdown();
    assert.equal(code, 0);
    assert.deepEqual(s.badLines, [], "stdout must contain JSON-RPC lines only");
  } finally {
    if (s.child.exitCode === null) s.child.kill();
  }
});

test("MCP: missing skill roots -> E_UNAVAILABLE, server keeps working", async () => {
  const emptyHome = tmpDir("emptyhome");
  const s = startServer(emptyHome);
  try {
    await s.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "node-test", version: "1.0.0" } });
    s.notify("notifications/initialized");

    const unavailable = await s.request("tools/call", { name: "find", arguments: { query: "anything" } });
    const payload = payloadOf(unavailable);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "E_UNAVAILABLE");
    assert.equal(unavailable.result.isError, true);

    // the server is still alive after the failure
    const ping = await s.request("ping");
    assert.deepEqual(ping.result, {});
    const list = await s.request("tools/list");
    assert.equal(list.result.tools.length, 3);

    const code = await s.shutdown();
    assert.equal(code, 0);
  } finally {
    if (s.child.exitCode === null) s.child.kill();
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

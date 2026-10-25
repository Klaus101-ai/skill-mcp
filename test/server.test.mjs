// MCP server tests: spawn server/index.mjs as a child process, speak
// newline-delimited JSON-RPC 2.0 over stdio, then close stdin and assert the
// server exits on EOF. Requests carry a 10s timeout so nothing can hang.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultRoots, discoverSkills, extractHeadingEntries } from "../core/sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT = path.join(HERE, "..");
const SERVER = path.join(PRODUCT, "server", "index.mjs");

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: PRODUCT,
    env: { ...process.env, ...extraEnv },
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
  const { skills } = discoverSkills(defaultRoots());
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
    assert.equal(init.result.serverInfo.name, "skill-router");
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
    }

    // find: empty query
    const empty = payloadOf(await s.request("tools/call", { name: "find", arguments: { query: "" } }));
    assert.deepEqual(empty, { ok: true, items: [], note: "пустой запрос" });

    // find: AC3 — meaningful tokens of this query are in no skill text
    // (M7 coverage gate in core search) -> the documented empty answer.
    const noMatch = payloadOf(
      await s.request("tools/call", { name: "find", arguments: { query: "Как сварить борщ с говядиной" } }),
    );
    assert.deepEqual(noMatch, { ok: true, items: [], note: "ничего не найдено" });

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

test("MCP: outline caps at 40 headings and sets truncated:true", async () => {
  const { skills } = discoverSkills(defaultRoots());
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

test("MCP: missing skill roots -> E_UNAVAILABLE, server keeps working", async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-router-emptyhome-"));
  const s = startServer({ USERPROFILE: emptyHome });
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

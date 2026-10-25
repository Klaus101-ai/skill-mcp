import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSkillPath, PathForbiddenError, PathNotFoundError } from "../core/sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX_ROOT = path.join(HERE, "fixtures", "root");
const FIX_OUTSIDE = path.join(HERE, "fixtures", "outside");
const INSIDE_SKILL = path.join(FIX_ROOT, "skill-alpha", "SKILL.md");
const OUTSIDE_SKILL = path.join(FIX_OUTSIDE, "SKILL.md");

test("resolveSkillPath accepts a path inside the root", () => {
  const resolved = resolveSkillPath({ path: INSIDE_SKILL }, FIX_ROOT);
  assert.ok(resolved.endsWith(path.join("skill-alpha", "SKILL.md")));
});

test("resolveSkillPath refuses traversal outside the root", () => {
  const traversal = path.join(FIX_ROOT, "..", "outside", "SKILL.md");
  assert.throws(
    () => resolveSkillPath({ path: traversal }, FIX_ROOT),
    (err) => err instanceof PathForbiddenError && err.code === "E_FORBIDDEN",
  );
});

test("resolveSkillPath refuses an absolute path outside the root", () => {
  assert.throws(
    () => resolveSkillPath({ path: OUTSIDE_SKILL }, FIX_ROOT),
    (err) => err instanceof PathForbiddenError && err.code === "E_FORBIDDEN",
  );
});

test("resolveSkillPath reports missing paths as E_NOT_FOUND", () => {
  assert.throws(
    () => resolveSkillPath({ path: path.join(FIX_ROOT, "nope", "SKILL.md") }, FIX_ROOT),
    (err) => err instanceof PathNotFoundError && err.code === "E_NOT_FOUND",
  );
});

test("core modules contain no network calls (R5)", () => {
  const coreDir = path.join(HERE, "..", "core");
  const forbidden = [
    /from\s+["']node:(http|https|net|dns|tls|dgram)["']/,
    /require\(\s*["'](http|https|net|dns|tls|dgram)["']\s*\)/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /WebSocket/,
  ];
  for (const file of fs.readdirSync(coreDir)) {
    if (!file.endsWith(".mjs")) continue;
    const src = fs.readFileSync(path.join(coreDir, file), "utf8");
    for (const rx of forbidden) {
      assert.ok(!rx.test(src), `${file} matches forbidden pattern ${rx}`);
    }
  }
});

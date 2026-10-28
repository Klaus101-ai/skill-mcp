// Regression tests for the 26.10.2026 home-leak incident: a test child
// process resolved the REAL home directory and fixtures were written into the
// real ~/.config/opencode/skills. These tests pin the isolation contract:
//   (а) isolatedEnv() never carries the real home values;
//   (б) `init --config <temp>` inside an isolated home writes ONLY the config
//       and its .bak — never a skills folder;
//   (в) the temp home is never the real home and never touches the real skill
//       roots (full path-disjointness from os.homedir() is impossible on
//       Windows — os.tmpdir() lives inside the user profile — so the
//       meaningful invariants are asserted);
//   (г) end-to-end canary: doctor over an isolated home with ONE fixture
//       skill reports exactly 1 indexed skill — with a leaked real env it
//       would report the whole real corpus, and this test fails.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpDir, isolatedEnv, HOME_ENV_KEYS } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CLI = path.join(ROOT, "dist", "cli.mjs");
const SERVER = path.join(ROOT, "dist", "server.mjs");

// Ensure dist/ is built (same guard as cli.test.mjs; dist/ normally exists).
if (!fs.existsSync(CLI) || !fs.existsSync(SERVER)) {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], {
    cwd: ROOT,
    stdio: "ignore",
    env: isolatedEnv(tmpDir("build")),
  });
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ── (а) env из helper не содержит реального домашнего пути ──────────────────

test("isolatedEnv: home keys point inside the temp home, never at the real one", () => {
  const home = tmpDir("envcheck");
  const env = isolatedEnv(home);
  const realHome = path.resolve(os.homedir());

  for (const key of HOME_ENV_KEYS) {
    const value = env[key];
    assert.equal(typeof value, "string", `${key} must be set`);
    assert.ok(
      value === home || isInside(home, path.resolve(value)),
      `${key}=${value} must be the temp home or inside it (${home})`,
    );
    assert.notEqual(path.resolve(value), realHome, `${key} must not be the real home`);
  }
  // The Windows pair resolves os.homedir(); both must be redirected.
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  // The real env values for these keys are never inherited (they may be
  // absent on this platform — then the inherited value must be absent too).
  for (const key of HOME_ENV_KEYS) {
    assert.notEqual(env[key], process.env[key], `${key} must not inherit the real value`);
  }
  // Everything else (PATH etc.) is inherited — the child must still run.
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path, "PATH is inherited");
});

// ── (б) init --config <temp> не пишет skills ────────────────────────────────

test("isolated init --config <temp>: only the config and its .bak appear, no skills folder", () => {
  const home = tmpDir("inithome");
  const cfgDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfg = path.join(cfgDir, "opencode.jsonc");
  fs.writeFileSync(cfg, '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', "utf8");

  const r = spawnSync(process.execPath, [CLI, "init", "--config", cfg, "--yes"], {
    encoding: "utf8",
    env: isolatedEnv(home),
  });
  assert.equal(r.status, 0, `init exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);

  // Collect everything under the temp home (relative paths, / separators).
  const files = [];
  const dirs = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
        walk(full);
      } else {
        files.push(path.relative(home, full).split(path.sep).join("/"));
      }
    }
  })(home);

  assert.ok(
    !dirs.some((d) => path.basename(d) === "skills"),
    `no skills folder may appear under the temp home, got dirs: ${dirs.join(", ")}`,
  );
  assert.ok(files.includes(".config/opencode/opencode.jsonc"), "the config itself is written");
  assert.ok(
    files.some((f) => /^\.config\/opencode\/opencode\.jsonc\.bak-\d{8}-\d{4}$/.test(f)),
    `exactly one .bak of the config is expected, got files: ${files.join(", ")}`,
  );
  assert.equal(files.length, 2, `only the config + its .bak may exist, got: ${files.join(", ")}`);
});

// ── (в) временный home не является реальным домом и не трогает реальные корни ─

test("tmpDir/isolatedEnv: the temp home is not the real home and never intersects the real skill roots", () => {
  const home = path.resolve(tmpDir("overlap"));
  const realHome = path.resolve(os.homedir());

  // The temp home is a verified os.tmpdir() child (tmpDir throws otherwise) …
  assert.ok(isInside(path.resolve(os.tmpdir()), home), `${home} must be inside os.tmpdir()`);
  // … is never the real home, and never contains it.
  assert.notEqual(home, realHome);
  assert.ok(!isInside(home, realHome), "the temp home must not contain the real home");

  // No real skill root lies inside the temp home, and the temp home does not
  // live inside a real skill root — the two trees are disjoint in both
  // directions. (os.homedir() itself CONTAINS os.tmpdir() on Windows, so
  // disjointness from os.homedir() as a whole is impossible by design; the
  // writable skill roots are what the incident touched.)
  const realRoots = [
    ".config/opencode/skills",
    ".config/opencode/skill",
    ".opencode/skills",
    ".claude/skills",
    ".agents/skills",
  ].map((rel) => path.join(realHome, rel));
  for (const root of realRoots) {
    assert.ok(!isInside(home, root), `${root} must not be inside the temp home`);
    if (fs.existsSync(root)) {
      assert.ok(!isInside(root, home), `the temp home must not live inside ${root}`);
    }
  }
});

// ── (г) end-to-end canary: утечка env роняет тест ───────────────────────────

test("canary: doctor over an isolated home with 1 fixture skill indexes exactly 1 (a leaked env would index the real corpus)", () => {
  const home = tmpDir("canaryhome");
  const skillDir = path.join(home, ".config", "opencode", "skills", "iso-fixture");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: iso-fixture\ndescription: The only skill inside the isolated home.\n---\n\n# iso-fixture\n\n## When to use\n- task about isolation\n",
    "utf8",
  );
  const cfgDir = path.join(home, ".config", "opencode");
  const cfg = path.join(cfgDir, "opencode.jsonc");
  fs.writeFileSync(cfg, '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', "utf8");
  spawnSync(process.execPath, [CLI, "init", "--config", cfg, "--yes"], {
    encoding: "utf8",
    env: isolatedEnv(home),
  });

  const doctor = spawnSync(process.execPath, [CLI, "doctor", "--config", cfg], {
    encoding: "utf8",
    env: isolatedEnv(home),
  });
  const out = doctor.stdout ?? "";
  assert.match(out, /skills indexed: 1 SKILL\.md/, `expected exactly the isolated corpus:\n${out}`);
  assert.ok(!/skills indexed: [2-9]\d\d /.test(out), `the real corpus must never be indexed:\n${out}`);
});

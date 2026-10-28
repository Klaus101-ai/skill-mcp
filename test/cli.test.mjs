// Tests for the skill-mcp CLI (`cli/main.mjs`, exercised via the built
// `dist/cli.mjs`). These run the REAL CLI as a child process so the shebang,
// jsonc-parser edits, backups and the stdio serve loop are all covered.
//
// A build is ensured once per run (esbuild is a devDependency) so `dist/`
// exists; the serve smoke then drives the built server over stdio.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpDir, isolatedEnv } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CLI = path.join(ROOT, "dist", "cli.mjs");
const SERVER = path.join(ROOT, "dist", "server.mjs");
const PLUGIN_DIR = path.join(ROOT, "dist", "plugin");

// Ensure dist/ is built (once). esbuild is fast (~100ms). The build child gets
// the same isolated env as every other spawn — no child ever sees the real home.
if (!fs.existsSync(CLI) || !fs.existsSync(SERVER)) {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], {
    cwd: ROOT,
    stdio: "ignore",
    env: isolatedEnv(tmpDir("build")),
  });
}

const CONFIG_WITH_COMMENTS = `{
  // owner comment: my main config
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-6",
  // mcp block
  "mcp": {
    "other": { "type": "local", "command": ["node", "other.mjs"], "enabled": true }
  },
  "plugins": [
    "./local-plugin.ts"
  ]
}
`;

function writeConfig(dir, text = CONFIG_WITH_COMMENTS) {
  const p = path.join(dir, "opencode.jsonc");
  fs.writeFileSync(p, text, "utf8");
  return p;
}

// Every CLI child runs with an ISOLATED env: HOME/USERPROFILE/XDG_*/APPDATA/*
// point inside `home` (a temp dir) and the real values are never inherited —
// the 26.10.2026 leak wrote test fixtures into the real skills dir. `home` is
// mandatory: a forgotten argument must fail loudly, not fall back to the real
// environment.
function runCli(args, home) {
  if (typeof home !== "string" || home === "") {
    throw new Error("runCli: home is required — pass an isolated temp home (tmpDir)");
  }
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: isolatedEnv(home),
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// ── init ────────────────────────────────────────────────────────────────────

test("init --dry-run: shows a diff, writes nothing, makes no backup", () => {
  const dir = tmpDir("dryrun");
  const cfg = writeConfig(dir);
  const before = fs.readFileSync(cfg, "utf8");
  const { code, out } = runCli(["init", "--config", cfg, "--dry-run"], dir);

  assert.equal(code, 0, `exit 0, got ${code}: ${out}`);
  assert.match(out, /diff \(before → after\)/);
  assert.match(out, /dry-run: no file written/);
  assert.equal(fs.readFileSync(cfg, "utf8"), before, "config unchanged by --dry-run");
  const baks = fs.readdirSync(dir).filter((f) => f.includes(".bak-"));
  assert.equal(baks.length, 0, "no backup on --dry-run");
});

test("init: writes mcp + plugins, keeps JSONC comments, makes a .bak backup", () => {
  const dir = tmpDir("install");
  const cfg = writeConfig(dir);
  const { code, out } = runCli(["init", "--config", cfg, "--yes"], dir);

  assert.equal(code, 0, `exit 0, got ${code}: ${out}`);
  const after = fs.readFileSync(cfg, "utf8");
  // Comments preserved (jsonc-parser keeps them).
  assert.ok(after.includes("// owner comment: my main config"), "owner comment kept");
  assert.ok(after.includes("// mcp block"), "mcp comment kept");
  // mcp entry written with the absolute server path.
  assert.ok(after.includes('"skill-mcp"'), "mcp key present");
  assert.ok(after.includes(SERVER.replace(/\\/g, "\\\\")), "server path present");
  // plugins entry appended, existing entry preserved.
  assert.ok(after.includes("./local-plugin.ts"), "existing plugin kept");
  assert.ok(after.includes(PLUGIN_DIR.replace(/\\/g, "\\\\")), "plugin dir appended");
  // Backup created and holds the ORIGINAL text.
  const baks = fs.readdirSync(dir).filter((f) => f.includes(".bak-"));
  assert.equal(baks.length, 1, "exactly one backup");
  assert.equal(fs.readFileSync(path.join(dir, baks[0]), "utf8"), CONFIG_WITH_COMMENTS, "backup == original");
  assert.match(out, /backup: /);
  assert.match(out, /written: /);
});

test("init is idempotent: a second run reports already-configured and writes nothing", () => {
  const dir = tmpDir("idem");
  const cfg = writeConfig(dir);
  runCli(["init", "--config", cfg, "--yes"], dir);
  const afterFirst = fs.readFileSync(cfg, "utf8");
  const baksAfterFirst = fs.readdirSync(dir).filter((f) => f.includes(".bak-")).length;

  const { code, out } = runCli(["init", "--config", cfg, "--yes"], dir);
  assert.equal(code, 0, `exit 0, got ${code}: ${out}`);
  assert.match(out, /already configured/);
  assert.equal(fs.readFileSync(cfg, "utf8"), afterFirst, "config unchanged on re-run");
  const baksAfterSecond = fs.readdirSync(dir).filter((f) => f.includes(".bak-")).length;
  assert.equal(baksAfterSecond, baksAfterFirst, "no new backup on idempotent re-run");
});

test("init --uninstall: removes mcp entry and plugin dir, keeps everything else", () => {
  const dir = tmpDir("uninstall");
  const cfg = writeConfig(dir);
  runCli(["init", "--config", cfg, "--yes"], dir);

  const { code, out } = runCli(["init", "--config", cfg, "--yes", "--uninstall"], dir);
  assert.equal(code, 0, `exit 0, got ${code}: ${out}`);
  const after = fs.readFileSync(cfg, "utf8");
  assert.ok(!after.includes('"skill-mcp"'), "mcp entry removed");
  assert.ok(!after.includes(PLUGIN_DIR.replace(/\\/g, "\\\\")), "plugin dir removed");
  assert.ok(after.includes("./local-plugin.ts"), "unrelated plugin untouched");
  assert.ok(after.includes("// owner comment"), "comments survive uninstall");
});

// ── doctor ──────────────────────────────────────────────────────────────────

test("doctor: green (exit 0) on a fixture home after init", () => {
  const home = tmpDir("doctorhome");
  const skills = path.join(home, ".config", "opencode", "skills");
  for (const [name, desc] of Object.entries({
    promo: "Продающие лендинги и промостраницы: офферы, заголовки, CTA, описания продукта.",
    "dpa-review": "Review договора об обработке персональных данных (ДОУ) по 152-ФЗ.",
    copywriting: "Write marketing copy for landing pages, product pages, ads: headline, CTA.",
  })) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(
      path.join(skills, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n## When to use\n- task\n`,
      "utf8",
    );
  }
  const cfgDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfg = path.join(cfgDir, "opencode.jsonc");
  fs.writeFileSync(cfg, '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', "utf8");
  runCli(["init", "--config", cfg, "--yes"], home);

  const { code, out } = runCli(["doctor", "--config", cfg], home);
  assert.equal(code, 0, `doctor exit 0, got ${code}:\n${out}`);
  assert.match(out, /skills indexed: 3 SKILL\.md/);
  assert.match(out, /doctor: OK/);
});

test("doctor: exit 1 when the mcp entry is missing", () => {
  const dir = tmpDir("doctorbad");
  const cfg = writeConfig(dir, '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
  const { code, out } = runCli(["doctor", "--config", cfg], dir);
  assert.equal(code, 1, `doctor exit 1, got ${code}`);
  assert.match(out, /mcp\.skill-mcp present/);
  assert.match(out, /doctor: problems found/);
});

// ── serve ───────────────────────────────────────────────────────────────────

test("serve: stdio find returns promo first over a fixture home", () => {
  const home = tmpDir("servehome");
  const skills = path.join(home, ".config", "opencode", "skills");
  for (const [name, desc] of Object.entries({
    promo: "Продающие лендинги и промостраницы: офферы, заголовки, CTA, описания продукта и лендинга.",
    copywriting: "Write marketing copy for landing pages, product pages, ads: headline, CTA.",
  })) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(
      path.join(skills, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n## When to use\n- task\n`,
      "utf8",
    );
  }

  const lines = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find","arguments":{"query":"продающий лендинг","limit":3}}}',
  ].join("\n");

  const r = spawnSync(process.execPath, [CLI, "serve"], {
    encoding: "utf8",
    input: lines, // stdin closes after the messages → server exits (code 0)
    env: isolatedEnv(home),
    timeout: 20000,
  });
  assert.equal(r.status, 0, `serve exit 0, got ${r.status}: ${r.stderr}`);
  const stdout = r.stdout;
  assert.match(stdout, /"protocolVersion"/, "initialize answered");
  // Parse the find response and assert promo is the first item.
  const findLine = stdout.split("\n").find((l) => l.includes('"id":2'));
  assert.ok(findLine, "find response present");
  const msg = JSON.parse(findLine);
  const payload = JSON.parse(msg.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.items[0].name, "promo", `promo first, got ${payload.items.map((i) => i.name).join(",")}`);
});

// ── --help / --version ──────────────────────────────────────────────────────

test("--version prints the package version; --help lists the commands", () => {
  const home = tmpDir("meta");
  const v = runCli(["--version"], home);
  assert.equal(v.code, 0);
  assert.match(v.out.trim(), /^\d+\.\d+\.\d+$/);
  const h = runCli(["--help"], home);
  assert.equal(h.code, 0);
  assert.match(h.out, /skill-mcp init/);
  assert.match(h.out, /skill-mcp doctor/);
  assert.match(h.out, /skill-mcp serve/);
});

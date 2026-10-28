#!/usr/bin/env node
// skill-mcp CLI — install / diagnose / serve. Local, no network, no LLM.
//
//   skill-mcp init [--config <path>] [--dry-run] [--yes] [--uninstall]
//   skill-mcp doctor [--config <path>]
//   skill-mcp serve
//   skill-mcp --help | --version
//
// `init` edits an opencode config (JSONC, comments preserved via jsonc-parser),
// makes a `.bak-YYYYMMDD-HHMM` backup, shows a diff, and is idempotent.
// Everything is read/write-local only; the owner's real config is never touched
// unless they run this command themselves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parse as jsoncParse, modify as jsoncModify, applyEdits as jsoncApplyEdits } from "jsonc-parser";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";
import { buildIndex, search } from "../core/index.mjs";
import { DEFAULT_CONFIG_PATH } from "../plugin/hint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// In dist/, the CLI lives at <pkg>/dist/cli.mjs → package root is one level up.
// This is also where the installed server + plugin directory are resolved from.
const PKG_ROOT = path.dirname(HERE);
const SERVER_PATH = path.join(PKG_ROOT, "dist", "server.mjs");
const PLUGIN_DIR = path.join(PKG_ROOT, "dist", "plugin");

const PKG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
  } catch {
    return { name: "skill-finder-mcp", version: "0.0.0" };
  }
})();

const MCP_KEY = "skill-mcp";
const FMT = { insertSpaces: true, tabSize: 2, eol: "\n" };

function out(...a) {
  process.stdout.write(`${a.join(" ")}\n`);
}
function err(...a) {
  process.stderr.write(`${a.join(" ")}\n`);
}

// ── argument parsing ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [], config: null, dryRun: false, yes: false, uninstall: false, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--config") {
      args.config = argv[i + 1] ?? null;
      i += 1;
      if (!args.config) throw new Error("--config requires a path");
    } else if (a.startsWith("--config=")) {
      args.config = a.slice("--config=".length);
      if (!args.config) throw new Error("--config requires a path");
    } else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--uninstall") args.uninstall = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else args._.push(a);
  }
  return args;
}

// ── config discovery ────────────────────────────────────────────────────────
function globalConfigCandidates() {
  const base = path.join(os.homedir(), ".config", "opencode");
  return [path.join(base, "opencode.jsonc"), path.join(base, "opencode.json")];
}

/** Resolve which config file to use: --config wins, else first existing global, else create .jsonc. */
function resolveConfigPath(explicit) {
  if (explicit) return { path: path.resolve(explicit), exists: fs.existsSync(path.resolve(explicit)), created: false };
  const cands = globalConfigCandidates();
  for (const c of cands) {
    if (fs.existsSync(c)) return { path: c, exists: true, created: false };
  }
  return { path: cands[0], exists: false, created: true };
}

function readConfig(text, file) {
  const errors = [];
  const value = jsoncParse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const e = errors[0];
    const line = text.slice(0, e.offset).split(/\r?\n/).length;
    throw new Error(`${file}: invalid JSONC at line ${line} (offset ${e.offset}, error code ${e.error}) — fix it or pass --config <path>`);
  }
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: top-level JSON value must be an object`);
  }
  return value;
}

// ── JSONC edits (comments preserved) ────────────────────────────────────────
function edit(text, editPath, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edits = jsoncModify(text, editPath, value, { formattingOptions: { ...FMT, eol } });
  return jsoncApplyEdits(text, edits);
}

// ── diff (common prefix/suffix trim; honest and readable) ───────────────────
function diffLines(before, after) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = `  (${start} unchanged leading line(s), ${a.length - endA} unchanged trailing line(s) omitted)`;
  const body = [];
  for (let i = start; i < endA; i += 1) body.push(`- ${a[i]}`);
  for (let i = start; i < endB; i += 1) body.push(`+ ${b[i]}`);
  if (body.length === 0) return "(no changes)";
  return [head, ...body].join("\n");
}

// ── backup ──────────────────────────────────────────────────────────────────
function backupName(file) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${file}.bak-${stamp}`;
}

// ── build the new config text ───────────────────────────────────────────────
function seedText() {
  // A fresh config: $schema + an installer comment. modify() keeps both.
  return '{\n  // skill-mcp installer (npx skill-finder-mcp init)\n  "$schema": "https://opencode.ai/config.json"\n}\n';
}

function desiredMcpEntry() {
  return { type: "local", command: ["node", SERVER_PATH], enabled: true };
}

function applyInit(text) {
  let next = text;
  next = edit(next, ["mcp", MCP_KEY], desiredMcpEntry());
  const cur = jsoncParse(next, [], { allowTrailingComma: true });
  const plugins = Array.isArray(cur.plugins) ? cur.plugins : [];
  if (!plugins.includes(PLUGIN_DIR)) {
    if (Array.isArray(cur.plugins)) {
      next = edit(next, ["plugins", plugins.length], PLUGIN_DIR); // append, keeps existing entries/comments
    } else {
      next = edit(next, ["plugins"], [PLUGIN_DIR]);
    }
  }
  return next;
}

function applyUninstall(text) {
  let next = text;
  const cur = jsoncParse(next, [], { allowTrailingComma: true });
  if (cur && cur.mcp && Object.prototype.hasOwnProperty.call(cur.mcp, MCP_KEY)) {
    next = edit(next, ["mcp", MCP_KEY], undefined);
  }
  const plugins = cur && Array.isArray(cur.plugins) ? cur.plugins : [];
  const idx = plugins.indexOf(PLUGIN_DIR);
  if (idx >= 0) next = edit(next, ["plugins", idx], undefined);
  return next;
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdInit(args) {
  const target = resolveConfigPath(args.config);
  const exists = fs.existsSync(target.path);
  const original = exists ? fs.readFileSync(target.path, "utf8") : seedText();
  const parsedValue = exists ? readConfig(original, target.path) : {};

  const alreadyMcp =
    parsedValue.mcp && parsedValue.mcp[MCP_KEY] && JSON.stringify(parsedValue.mcp[MCP_KEY]) === JSON.stringify(desiredMcpEntry());
  const alreadyPlugin = Array.isArray(parsedValue.plugins) && parsedValue.plugins.includes(PLUGIN_DIR);

  if (args.uninstall) {
    const next = applyUninstall(original);
    if (next === original) {
      out(`skill-mcp: not configured in ${target.path} — nothing to uninstall.`);
      return 0;
    }
    return finishWrite(args, target.path, original, next, "uninstall");
  }

  if (alreadyMcp && alreadyPlugin) {
    out(`skill-mcp: already configured in ${target.path}.`);
    out(`  mcp.${MCP_KEY}.command[1] = ${SERVER_PATH}`);
    out(`  plugins += ${PLUGIN_DIR}`);
    out("Restart opencode to apply (config is read once at startup).");
    return 0;
  }

  const next = applyInit(original);
  if (next === original) {
    out(`skill-mcp: no change needed in ${target.path}.`);
    return 0;
  }
  return finishWrite(args, target.path, original, next, "install");
}

function finishWrite(args, file, original, next, verb) {
  out(`skill-mcp ${verb}: ${file}`);
  out("diff (before → after):");
  out(diffLines(original, next));
  out(`  server: ${SERVER_PATH}`);
  out(`  plugin: ${PLUGIN_DIR}`);

  if (args.dryRun) {
    out("dry-run: no file written, no backup made.");
    return 0;
  }

  if (!args.yes) {
    if (!process.stdin.isTTY) {
      err("skill-mcp: non-interactive terminal — pass --yes to apply, or --dry-run to preview.");
      return 1;
    }
    const answer = promptSync(`Apply these changes? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      out("aborted: nothing written.");
      return 1;
    }
  }

  if (fs.existsSync(file)) {
    const bak = backupName(file);
    fs.copyFileSync(file, bak);
    out(`backup: ${bak}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, "utf8");
  out(`written: ${file}`);
  out("Restart opencode to apply (config is read once at startup).");
  return 0;
}

// Minimal synchronous TTY prompt (no dependency).
function promptSync(question) {
  fs.writeSync(2, question);
  try {
    const fd = fs.openSync("/dev/tty", "rs");
    const buf = Buffer.alloc(1);
    let line = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n === 0 || buf[0] === 0x0a) break;
      line += String(buf[0]);
    }
    fs.closeSync(fd);
    return line;
  } catch {
    return "";
  }
}

function cmdDoctor(args) {
  const target = resolveConfigPath(args.config);
  const rows = [];
  let ok = true;
  const check = (pass, label, detail) => {
    rows.push(`${pass ? "✔" : "✖"} ${label}${detail ? `: ${detail}` : ""}`);
    if (!pass) ok = false;
  };

  // 1. Node >= 20
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 20, "node >= 20", process.version);

  // 2. Config path
  const exists = fs.existsSync(target.path);
  rows.push(`ℹ config: ${target.path}${exists ? "" : " (missing)"}`);
  let cfg = {};
  if (exists) {
    try {
      cfg = readConfig(fs.readFileSync(target.path, "utf8"), target.path);
    } catch (e) {
      check(false, "config parses", e.message);
    }
  }

  // 3. mcp entry + server file
  const mcpEntry = cfg.mcp && cfg.mcp[MCP_KEY];
  check(!!mcpEntry, `mcp.${MCP_KEY} present`, mcpEntry ? JSON.stringify(mcpEntry.command) : "add it: skill-mcp init");
  if (mcpEntry && Array.isArray(mcpEntry.command)) {
    const srv = mcpEntry.command[1];
    check(fs.existsSync(srv), "mcp server file exists", srv);
  }

  // 4. plugins entry + directory/index
  // Match the canonical `dist/plugin` suffix that `init` writes (works for any
  // install root — repo checkout `skill-router`, npm scope `skill-mcp`, …) and,
  // for robustness, any path containing the `skill-mcp` package name.
  const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];
  const isSkillMcpPlugin = (p) =>
    typeof p === "string" && (/[\\/]dist[\\/]plugin$/.test(p) || p.includes("skill-mcp"));
  const pluginDir = plugins.find(isSkillMcpPlugin);
  check(!!pluginDir, "plugins entry present", pluginDir ?? "add it: skill-mcp init");
  if (pluginDir) {
    check(fs.existsSync(path.join(pluginDir, "index.mjs")), "plugin directory has index.mjs", pluginDir);
  }

  // 5. Skill roots + indexed count + probe search
  let roots = [];
  let indexed = 0;
  try {
    roots = defaultRoots();
    const { skills } = discoverSkills(roots);
    indexed = skills.length;
    check(roots.length > 0, "skill roots found", `${roots.length} root(s)`);
    check(indexed > 0, "skills indexed", `${indexed} SKILL.md`);
    if (indexed > 0) {
      const index = buildIndex(skills);
      const hits = search(index, "review a commercial contract", { limit: 5 });
      const names = hits.map((h) => h.name).join(", ") || "(none)";
      rows.push(`ℹ probe search top-5: ${names}`);
    }
  } catch (e) {
    check(false, "skill discovery", e.message);
  }

  // 6. Plugin config path + env
  rows.push(`ℹ plugin config: ${DEFAULT_CONFIG_PATH}${fs.existsSync(DEFAULT_CONFIG_PATH) ? "" : " (missing → defaults)"}`);
  const envs = Object.keys(process.env).filter((k) => k.startsWith("SKILL_MCP_"));
  rows.push(`ℹ env SKILL_MCP_*: ${envs.length ? envs.map((k) => `${k}=${process.env[k]}`).join(", ") : "(none)"}`);

  // 7. opencode version (non-fatal if absent)
  let ocVersion = null;
  try {
    ocVersion = execFileSync("opencode", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    ocVersion = null;
  }
  rows.push(`${ocVersion ? "ℹ" : "⚠"} opencode: ${ocVersion ?? "not found on PATH (install opencode to use skill-mcp)"}`);

  for (const r of rows) out(r);
  out(ok ? "doctor: OK" : "doctor: problems found (see ✖ above)");
  return ok ? 0 : 1;
}

async function cmdServe() {
  // Import dist/server.mjs at RUNTIME (computed path → esbuild leaves it unbundled).
  // Fallback to the source-tree layout for `node cli/main.mjs serve` during dev.
  const candidates = [path.join(HERE, "server.mjs"), path.join(HERE, "..", "server", "index.mjs")];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      await import(pathToFileURL(c).href); // starts the stdio loop
      return 0;
    }
  }
  throw new Error("skill-mcp: server bundle not found (run `npm run build`)");
}

const HELP = `skill-mcp ${PKG.version} — local skill search for opencode (no network, no LLM)

Usage:
  skill-mcp init [--config <path>] [--dry-run] [--yes] [--uninstall]
      Add mcp.${MCP_KEY} + the plugin to an opencode config (JSONC, comments kept).
      Makes a .bak-YYYYMMDD-HHMM backup and shows a diff. Idempotent.
        --config <path>   config file to edit (default: ~/.config/opencode/opencode.jsonc, else .json)
        --dry-run         show the diff, write nothing
        --yes             apply without an interactive prompt
        --uninstall       remove the mcp entry and plugin from the config

  skill-mcp doctor [--config <path>]
      Check node, config, mcp/plugin entries, skill roots, an index probe and env. Exit 0 = OK.

  skill-mcp serve
      Run the MCP server on stdio (normally started by opencode, not by hand).

  skill-mcp --help | --version
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    out(HELP);
    return 0;
  }
  if (args.version) {
    out(PKG.version);
    return 0;
  }
  const cmd = args._[0];
  if (cmd === "init") return cmdInit(args);
  if (cmd === "doctor") return cmdDoctor(args);
  if (cmd === "serve") return cmdServe();
  if (!cmd) {
    out(HELP);
    return 0;
  }
  err(`skill-mcp: unknown command "${cmd}". Run skill-mcp --help.`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === "number" && code !== 0) process.exitCode = code;
  },
  (e) => {
    err(`skill-mcp: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  },
);

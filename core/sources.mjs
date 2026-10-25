// Skill discovery: locate SKILL.md files under the default skill roots and
// parse their frontmatter. Read-only by contract (R5): this module never
// opens a file for writing and performs no network calls.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Default skill roots that actually exist, including the project one. */
export function defaultRoots(cwd = process.cwd()) {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".config", "opencode", "skill"),
    path.join(home, ".opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(cwd, ".opencode", "skills"),
  ];
  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

const BLOCK_HEADER = /^[A-Za-z_][\w-]*:\s*[|>][-+]?\s*$/;
const KV_LINE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

/**
 * Minimal YAML-subset frontmatter parser: `key: value` pairs, quoted values,
 * folded continuation lines and `|` / `>` block scalars. No external parser.
 * Returns { data, body, hasFrontmatter }.
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text, hasFrontmatter: false };

  const data = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i += 1;
      continue;
    }
    const kv = KV_LINE.exec(line);
    if (!kv) {
      i += 1;
      continue;
    }
    const key = kv[1];
    let value = kv[2].trim();
    i += 1;

    if (BLOCK_HEADER.test(line)) {
      // Block scalar: collect the indented block.
      const block = [];
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "") {
        block.push(lines[i].trim());
        i += 1;
      }
      value = value.startsWith(">") ? block.join(" ") : block.join("\n");
    } else if (value === "") {
      const block = [];
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "") {
        block.push(lines[i].trim());
        i += 1;
      }
      value = block.join(" ");
    } else {
      // Folded continuation of a multi-line scalar (indented extra lines).
      const block = [];
      while (
        i < lines.length &&
        /^[ \t]/.test(lines[i]) &&
        lines[i].trim() !== "" &&
        !KV_LINE.test(lines[i].trim())
      ) {
        block.push(lines[i].trim());
        i += 1;
      }
      if (block.length > 0) value = [value, ...block].join(" ");
    }

    data[key] = unquote(value);
  }

  return { data, body: text.slice(m[0].length), hasFrontmatter: true };
}

/** Headings of the body, skipping fenced code blocks. */
export function extractHeadings(body) {
  const out = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}

/** Parse a SKILL.md text into { name, description, bodyHeadings }. */
export function parseSkill(text) {
  const { data, body } = parseFrontmatter(text);
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
  const description = typeof data.description === "string" ? data.description.trim() : "";
  return { name, description, bodyHeadings: extractHeadings(body) };
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      yield full;
    }
  }
}

/**
 * Recursively discover SKILL.md files under the given roots.
 * Returns [{ name, path, description, bodyHeadings, root }]; duplicates
 * (same real path reached from different roots) are collapsed.
 */
export function discoverSkills(roots = defaultRoots()) {
  const seen = new Map();
  for (const root of roots) {
    for (const file of walk(root)) {
      let real;
      try {
        real = fs.realpathSync(file);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      let text;
      try {
        text = fs.readFileSync(real, "utf8"); // read-only
      } catch {
        continue;
      }
      const parsed = parseSkill(text);
      seen.set(real, {
        name: parsed.name || path.basename(path.dirname(real)),
        path: real,
        description: parsed.description,
        bodyHeadings: parsed.bodyHeadings,
        root,
      });
    }
  }
  return [...seen.values()];
}

export class PathForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathForbiddenError";
    this.code = "E_FORBIDDEN";
  }
}

export class PathNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathNotFoundError";
    this.code = "E_NOT_FOUND";
  }
}

/**
 * Resolve a skill path and refuse to return it when it escapes `root`
 * (path-traversal guard, AC4 groundwork). Returns the real absolute path.
 */
export function resolveSkillPath(skill, root) {
  const target = typeof skill === "string" ? skill : skill && skill.path;
  if (!target) throw new PathNotFoundError("path is required");
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw new PathNotFoundError(`root does not exist: ${root}`);
  }
  let realFile;
  try {
    realFile = fs.realpathSync(target);
  } catch {
    throw new PathNotFoundError(`cannot resolve path: ${target}`);
  }
  const rel = path.relative(realRoot, realFile);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathForbiddenError(`path escapes skill root: ${target}`);
  }
  return realFile;
}

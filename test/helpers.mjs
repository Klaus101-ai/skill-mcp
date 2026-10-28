// Shared test helpers: temp directories, an ISOLATED environment for child
// processes, and a snapshot seeder for the skill corpus.
//
// Incident 26.10.2026 23:24:22: a `node --test` child (the CLI) resolved the
// REAL home directory and test fixtures were written into the real
// C:\Users\<user>\.config\opencode\skills, clobbering live skills. From now on
// every spawned process gets isolatedEnv(<temp home>): the home-related env
// keys are REMOVED from the inherited env and re-pointed inside the temp
// home — the real values are never inherited.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Env keys that decide where a Node process looks for "home" data.
 * Windows needs USERPROFILE/APPDATA/LOCALAPPDATA; POSIX needs HOME and XDG_*.
 */
export const HOME_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
];

/** Home-relative locations of the skill roots (mirrors core/sources.mjs defaultRoots). */
export const HOME_SKILL_RELS = [
  ".config/opencode/skills",
  ".config/opencode/skill",
  ".opencode/skills",
  ".claude/skills",
  ".agents/skills",
];

/**
 * Strict containment check: `dir` must be a real subdirectory of `base`.
 * Throws with a clear message otherwise — a temp dir escaping os.tmpdir()
 * is exactly the class of bug that caused the 26.10.2026 leak.
 */
export function assertInsideTmpdir(base, dir) {
  const rel = path.relative(base, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`tmpDir: created path is not inside os.tmpdir(): ${dir} (base ${base})`);
  }
}

/** mkdtemp inside os.tmpdir(), verified; throws if the path escapes it. */
export function tmpDir(tag) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, `skill-mcp-${tag}-`)));
  assertInsideTmpdir(base, dir);
  return dir;
}

/**
 * Environment for a child process whose whole "home" is `home`.
 * The real values of HOME_ENV_KEYS are NOT inherited: the keys are dropped
 * from the copy of process.env and re-set to point inside `home`
 * (POSIX: HOME + XDG_*; Windows: USERPROFILE + APPDATA + LOCALAPPDATA).
 * The legacy Windows pair HOMEDRIVE/HOMEPATH (which reconstructs the real
 * home) is scrubbed. Everything else (PATH, SystemRoot, …) is inherited.
 */
export function isolatedEnv(home) {
  const env = { ...process.env };
  for (const key of HOME_ENV_KEYS) delete env[key];
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  env.APPDATA = path.join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  return env;
}

/**
 * Snapshot-copy the REAL skill corpus (SKILL.md files only, directory
 * structure kept) into `home`, so tests that were written against the real
 * corpus keep their meaning while children never see the real home.
 * READ-ONLY on the source. Returns the number of SKILL.md files copied.
 */
export function seedSkillsHome(home) {
  const realHome = os.homedir();
  let copied = 0;
  const copyWalk = (src, dst) => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyWalk(s, d);
      } else if (entry.name === "SKILL.md") {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        copied += 1;
      }
    }
  };
  for (const rel of HOME_SKILL_RELS) {
    const src = path.join(realHome, rel);
    if (fs.existsSync(src)) copyWalk(src, path.join(home, rel));
  }
  return copied;
}

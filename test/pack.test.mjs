// Regression guard for the package contents (owner task 27.10.2026, N1):
// `npm pack` used to ship 32 files / ~244 kB instead of 9 / ~108 kB, because
// npm auto-includes root README*/LICENSE* regardless of files[] — so all 22
// `README.md.bak-*` and the `LICENSE.bak-*` backups landed in the tarball.
// The backups now live in `_backups/`; this test fails if any `.bak-` file or
// any file outside the allowed set creeps back into the packed file list.
//
// The test runs `npm pack --dry-run --json --ignore-scripts` into a temp
// directory: --dry-run never writes a .tgz anywhere, --ignore-scripts skips
// the prepack rebuild (this test checks the file LIST, not the build).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The allowed pack set, verbatim from the owner's task (N1):
const ALLOWED = new Set([
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "dist/cli.mjs",
  "dist/plugin.mjs",
  "dist/server.mjs",
  "dist/plugin/index.mjs",
  "dist/lexicon.ru-en.json",
]);

function packFileList() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "skill-mcp-pack-"));
  try {
    const res = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts", "--pack-destination", dest],
      {
        cwd: ROOT,
        encoding: "utf8",
        shell: process.platform === "win32", // npm is npm.cmd on Windows
        timeout: 120_000,
      },
    );
    assert.equal(res.status, 0, `npm pack --dry-run failed: ${res.stderr}`);
    const report = JSON.parse(String(res.stdout).replace(/^\uFEFF/, "").trim());
    assert.ok(Array.isArray(report) && report.length === 1, "expected one pack report");
    return report[0];
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

test("npm pack contents: no .bak- files, nothing outside the allowed set", () => {
  const report = packFileList();
  const files = report.files.map((f) => f.path);

  assert.ok(files.length > 0, "pack file list is empty");
  assert.deepEqual(files.filter((p) => ALLOWED.has(p)).length, files.length,
    `files outside the allowed set: ${files.filter((p) => !ALLOWED.has(p)).join(", ")}`);
  assert.deepEqual(files.filter((p) => p.includes(".bak-")), [],
    "backup files must not be packed (move them to _backups/)");
  assert.ok(files.includes("package.json"), "package.json must be packed");
});

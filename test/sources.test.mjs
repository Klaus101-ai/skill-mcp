import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseFrontmatter,
  parseSkill,
  discoverSkills,
  extractHeadingEntries,
  isInsideRoot,
} from "../core/sources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX_ROOT = path.join(HERE, "fixtures", "root");

test("frontmatter: multiline folded description is joined into one line", () => {
  const text = [
    "---",
    "name: alpha",
    "description: First line of alpha description.",
    "  Second line continues with more detail about widgets.",
    "---",
    "",
    "# Body",
  ].join("\n");
  const { data } = parseFrontmatter(text);
  assert.equal(
    data.description,
    "First line of alpha description. Second line continues with more detail about widgets.",
  );
  assert.equal(data.name, "alpha");
});

test("frontmatter: block scalar '>' description", () => {
  const text = [
    "---",
    "name: beta",
    "description: >",
    "  line one",
    "  line two",
    "---",
    "",
    "# Body",
  ].join("\n");
  const { data } = parseFrontmatter(text);
  assert.equal(data.description, "line one line two");
});

test("frontmatter: missing marker returns body untouched", () => {
  const text = "# No frontmatter\n\nJust text.\n";
  const { data, body, hasFrontmatter } = parseFrontmatter(text);
  assert.equal(hasFrontmatter, false);
  assert.deepEqual(data, {});
  assert.equal(body, text);
});

test("parseSkill: bodyHeadings skips fenced code blocks", () => {
  const text = [
    "---",
    "name: x",
    "description: d",
    "---",
    "",
    "# Real Heading",
    "",
    "```",
    "# Not A Heading",
    "```",
    "",
    "## Second Heading",
  ].join("\n");
  const parsed = parseSkill(text);
  assert.deepEqual(parsed.bodyHeadings, ["Real Heading", "Second Heading"]);
});

test("discoverSkills: finds fixture skills with fields", () => {
  const { skills, skipped } = discoverSkills([FIX_ROOT]);
  assert.deepEqual(skipped, []);
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["skill-alpha", "skill-beta", "skill-delta", "skill-omega", "skill-plain"]);

  const alpha = skills.find((s) => s.name === "skill-alpha");
  assert.ok(alpha.path.endsWith(path.join("skill-alpha", "SKILL.md")));
  assert.equal(alpha.root, FIX_ROOT);
  assert.ok(alpha.description.includes("Second line continues"));
  assert.ok(alpha.bodyHeadings.includes("Alpha Title"));
  assert.ok(alpha.bodyHeadings.includes("Section One"));
});

test("discoverSkills: skill without frontmatter falls back to folder name", () => {
  const { skills } = discoverSkills([FIX_ROOT]);
  const plain = skills.find((s) => s.path.includes("skill-plain"));
  assert.equal(plain.name, "skill-plain");
  assert.equal(plain.description, "");
  assert.ok(plain.bodyHeadings.includes("Plain skill without frontmatter"));
});

test("discoverSkills: nonexistent root yields no skills", () => {
  const { skills, skipped } = discoverSkills([path.join(HERE, "fixtures", "does-not-exist")]);
  assert.deepEqual(skills, []);
  assert.deepEqual(skipped, []);
});

test("frontmatter: UTF-8 BOM at the start of the file is stripped", () => {
  const text = "\uFEFF---\nname: bom-skill\ndescription: Has a byte order mark.\n---\n\n# Body\n";
  const { data, hasFrontmatter } = parseFrontmatter(text);
  assert.equal(hasFrontmatter, true);
  assert.equal(data.name, "bom-skill");
  assert.equal(data.description, "Has a byte order mark.");
  const parsed = parseSkill(text);
  assert.equal(parsed.name, "bom-skill");
});

test("frontmatter: a key with leading whitespace is recognised, not dropped", () => {
  const text = [
    "---",
    "name: indented",
    " description: Key with one leading space.",
    "   description2: Key with three leading spaces.",
    "---",
    "",
    "# Body",
  ].join("\n");
  const { data } = parseFrontmatter(text);
  assert.equal(data.name, "indented");
  assert.equal(data.description, "Key with one leading space.");
  assert.equal(data.description2, "Key with three leading spaces.");
});

test("frontmatter: indented continuation without a key still folds into the value", () => {
  const text = [
    "---",
    "name: fold",
    "description: First line.",
    "  continued without a colon here",
    "---",
    "",
    "# Body",
  ].join("\n");
  const { data } = parseFrontmatter(text);
  assert.equal(data.description, "First line. continued without a colon here");
});

test("discoverSkills: backup directories are skipped by exact segment name", () => {
  const { skills } = discoverSkills([FIX_ROOT]);
  const names = skills.map((s) => s.name);
  assert.ok(!names.includes("skill-ghost"), "skill from _backup must not be indexed");
  // Exact-segment matching: the directory is skipped, files above and beside
  // it are not.
  assert.ok(names.includes("skill-alpha"));
  assert.ok(names.includes("skill-plain"));
});

test("extractHeadingEntries: level, text and 1-based file line numbers", () => {
  const text = [
    "---",
    "name: x",
    "description: d",
    "---",
    "",
    "# Title", // line 6
    "",
    "```",
    "# Not A Heading", // line 9, inside fence
    "```",
    "",
    "## Section", // line 12
  ].join("\n");
  const entries = extractHeadingEntries(text);
  assert.deepEqual(entries, [
    { level: 1, text: "Title", line: 6 },
    { level: 2, text: "Section", line: 12 },
  ]);
});

test("isInsideRoot: same boundary as resolveSkillPath (AC4 groundwork)", () => {
  const root = path.join(path.parse(process.cwd()).root, "skills-root");
  assert.equal(isInsideRoot(root, path.join(root, "a", "SKILL.md")), true);
  assert.equal(isInsideRoot(root, root), false, "the root itself is not an entry inside it");
  assert.equal(isInsideRoot(root, path.join(root, "..", "escape", "SKILL.md")), false);
  assert.equal(isInsideRoot(root, path.join(path.parse(root).root, "other", "SKILL.md")), false);
});

test("discoverSkills: SKILL.md symlink escaping its root is skipped and reported", (t) => {
  const outsideFile = path.join(HERE, "fixtures", "outside", "SKILL.md");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "skill-router-link-"));
  const root = path.join(tmpBase, "root");
  fs.mkdirSync(root, { recursive: true });
  const link = path.join(root, "link-skill", "SKILL.md");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(outsideFile, link);
  } catch (err) {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    t.skip(`symlink creation not permitted on this host (${err.code || err.message})`);
    return;
  }
  try {
    const { skills, skipped } = discoverSkills([root]);
    assert.deepEqual(skills, [], "escaping symlink must not be indexed");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "outside-root");
    assert.equal(skipped[0].path, link);
    assert.equal(skipped[0].root, root);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

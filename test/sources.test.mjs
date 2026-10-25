import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFrontmatter,
  parseSkill,
  discoverSkills,
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
  const skills = discoverSkills([FIX_ROOT]);
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
  const skills = discoverSkills([FIX_ROOT]);
  const plain = skills.find((s) => s.path.includes("skill-plain"));
  assert.equal(plain.name, "skill-plain");
  assert.equal(plain.description, "");
  assert.ok(plain.bodyHeadings.includes("Plain skill without frontmatter"));
});

test("discoverSkills: nonexistent root yields no skills", () => {
  const skills = discoverSkills([path.join(HERE, "fixtures", "does-not-exist")]);
  assert.deepEqual(skills, []);
});

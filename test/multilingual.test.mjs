// CJK / South-East Asian script-aware segmentation (multilingual search).
//
// The plain split cut a space-less CJK phrase into ONE token, which only
// matched the same unbroken string («做原型» reached huashu-design only on an
// exact whole-token hit) and MIN_TOKEN_LENGTH = 3 dropped two-character words
// («网站», «高保真» → 0 results). Now every Han/Kana/Hangul/Thai/Lao/Khmer/
// Myanmar run is segmented: Intl.Segmenter word segments UNION character
// bigrams over the run; a CJK token of ≥ 2 chars may prove a match, a single
// character never may. Latin/Cyrillic must keep the OLD tokenize output
// byte-for-byte — checked against the original split below.
//
// Corpus tests build a REAL index over the local skills (same pattern as
// bilingual.test.mjs) and skip when a skill is absent on this host.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_TOKEN_LENGTH,
  isCjkToken,
  normalizeTerm,
  significantQueryTokens,
  tokenize,
} from "../core/text.mjs";
import { buildIndex, search } from "../core/index.mjs";
import { defaultRoots, discoverSkills } from "../core/sources.mjs";

const HAN = /[\p{Script=Han}]/u;

// ── 1. a CJK run becomes words, never one opaque mixed token ───────────────

test("cjk: a two-character run yields the word itself (site query)", () => {
  assert.deepEqual(tokenize("网站"), ["网站"]);
  assert.deepEqual(significantQueryTokens("网站"), ["网站"]);
});

test("cjk: a run always yields its character bigrams, whatever the dictionary says", () => {
  // bigrams are runtime-independent: they exist with and without Intl.Segmenter
  const tokens = tokenize("复刻网站");
  assert.ok(tokens.includes("复刻") && tokens.includes("网站"), `missing bigrams: ${tokens.join(",")}`);
  const sig = significantQueryTokens("复刻网站");
  assert.ok(sig.includes("网站") && sig.includes("复刻"), `missing significant CJK words: ${sig.join(",")}`);
});

test("cjk: 招商 (dictionary splits it into single chars) still yields a significant word", () => {
  // the acceptance failure that motivated this task: segments 招|商 are both
  // below any threshold — only the run bigram «招商» can be the query word
  assert.ok(tokenize("招商").includes("招商"), "the run bigram must exist");
  assert.deepEqual(significantQueryTokens("招商"), ["招商"]);
  assert.deepEqual(significantQueryTokens("投标"), ["投标"]);
});

test("cjk: single characters never prove a match (网, 作, ส)", () => {
  assert.deepEqual(significantQueryTokens("网"), []);
  assert.deepEqual(significantQueryTokens("作"), []);
  assert.deepEqual(significantQueryTokens("ส"), []);
});

test("cjk: CJK and Latin never fuse into one token (HTML原型)", () => {
  const tokens = tokenize("HTML原型");
  assert.ok(tokens.includes("HTML"), `latin side lost: ${tokens.join(",")}`);
  const mixed = tokens.filter((t) => HAN.test(t) && /[a-zA-Z]/.test(t));
  assert.deepEqual(mixed, [], `mixed-script tokens: ${mixed.join(",")}`);
});

test("cjk: repeated CJK tokens are deduplicated", () => {
  assert.deepEqual(tokenize("网站 网站 网站"), ["网站"]);
  assert.deepEqual(tokenize("高保真 高保真"), tokenize("高保真"));
});

// ── 2. normalize + significance thresholds ─────────────────────────────────

test("cjk: normalizeTerm keeps CJK (letters are letters)", () => {
  assert.equal(normalizeTerm("网站"), "网站");
  assert.equal(normalizeTerm("高保真 HTML"), "高保真html");
  assert.equal(normalizeTerm("投标。"), "投标");
  assert.equal(isCjkToken("网站"), true);
  assert.equal(isCjkToken("contract"), false);
  assert.equal(isCjkToken("договор"), false);
});

test("cjk: the 3-char threshold stays for Latin/Cyrillic and is skipped for CJK", () => {
  assert.equal(MIN_TOKEN_LENGTH, 3, "the shared threshold must not be changed");
  // Latin/Cyrillic keep the old rule: 2 chars prove nothing
  assert.deepEqual(significantQueryTokens("xy"), []);
  assert.deepEqual(significantQueryTokens("по"), []); // stop word, any length
  // CJK: 2 chars prove, 1 char does not (checked above)
  assert.deepEqual(significantQueryTokens("原型"), ["原型"]);
});

// ── 3. Latin/Cyrillic parity: the original split, byte for byte ────────────

test("cjk no-regression: tokenizing plain ru/en text equals the original split", () => {
  const oldTokenize = (s) =>
    s.split(/[^\p{L}\p{N}.]+/u).filter((t) => t !== "" && /[\p{L}\p{N}]/u.test(t));
  const plain = [
    "next.js gsap-scrolltrigger AI-документ",
    "проверь договор поставки",
    "Run the unit test suite before every release, keep the fixtures green",
    "тесты ... 42 2nd, ed. v1.2.3 «кавычки» — тире (и) [скобки]",
    "Sites: sitemap.xml, 3D/2D, B2B-услуги",
  ];
  for (const s of plain) {
    assert.deepEqual(tokenize(s), oldTokenize(s), `tokenize drifted for: ${s}`);
  }
});

test("cjk no-regression: significant ru/en tokens keep their old shape", () => {
  assert.deepEqual(significantQueryTokens("проверь договор поставки"), ["проверь", "договор", "поставк"]);
  assert.deepEqual(significantQueryTokens("AI ML UI"), ["ai", "ml", "ui"]);
});

// ── 4. fallback: Intl.Segmenter unavailable → bigrams only ─────────────────

test("cjk fallback: without Intl.Segmenter the run degrades to bigrams", () => {
  const original = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined; // writable on this runtime (verified 27.10.2026)
    assert.deepEqual(tokenize("高保真"), ["高保", "保真"], "bigrams over the whole run");
    assert.deepEqual(tokenize("网站"), ["网站"]);
    assert.deepEqual(significantQueryTokens("高保真"), ["高保", "保真"]);
    assert.deepEqual(significantQueryTokens("招商"), ["招商"]);
    assert.deepEqual(tokenize("contract"), ["contract"], "latin path must not notice");
  } finally {
    Intl.Segmenter = original;
  }
  // back on: the dictionary segments again
  assert.deepEqual(tokenize("contract"), ["contract"]);
});

// ── 5. the real corpus: buildIndex over the local skills ───────────────────

let corpusCache = null;
let corpusCacheSkills = [];

/** Real local skills -> one shared index; skips the test when the corpus (or an expected skill) is missing. */
function corpus(t, expected) {
  if (!corpusCache) {
    const { skills } = discoverSkills(defaultRoots());
    corpusCacheSkills = skills;
    corpusCache = skills.length > 0 ? buildIndex(skills) : null;
  }
  if (!corpusCache) {
    t.skip("no skill roots on this host");
    return null;
  }
  if (expected && !expected.some((name) => corpusCacheSkills.some((s) => s.name === name))) {
    t.skip(`none of [${expected.join(", ")}] present on this host`);
    return null;
  }
  return corpusCache;
}

const top = (idx, query) => search(idx, query, { limit: 10 }).map((r) => r.name);

test("corpus: 网站 finds a Chinese-described site skill in the top-10", (t) => {
  const idx = corpus(t, ["web-clone", "business-website-skill"]);
  if (!idx) return;
  const names = top(idx, "网站");
  assert.ok(
    names.includes("web-clone") || names.includes("business-website-skill"),
    `top-10: ${names.join(", ")}`,
  );
});

test("corpus: 高保真 finds huashu-design in the top-10", (t) => {
  const idx = corpus(t, ["huashu-design"]);
  if (!idx) return;
  const names = top(idx, "高保真");
  assert.ok(names.includes("huashu-design"), `top-10: ${names.join(", ")}`);
});

test("corpus: 做原型 still finds huashu-design (no regression vs the exact-token era)", (t) => {
  const idx = corpus(t, ["huashu-design"]);
  if (!idx) return;
  const names = top(idx, "做原型");
  assert.ok(names.includes("huashu-design"), `top-10: ${names.join(", ")}`);
});

test("corpus: 复刻网站 finds web-clone in the top-10", (t) => {
  const idx = corpus(t, ["web-clone"]);
  if (!idx) return;
  const names = top(idx, "复刻网站");
  assert.ok(names.includes("web-clone"), `top-10: ${names.join(", ")}`);
});

test("corpus: 幻灯片 finds huashu-design or slides in the top-10", (t) => {
  const idx = corpus(t, ["huashu-design", "slides"]);
  if (!idx) return;
  const names = top(idx, "幻灯片");
  assert.ok(
    names.includes("huashu-design") || names.includes("slides"),
    `top-10: ${names.join(", ")}`,
  );
});

test("corpus: 招商 finds business-website-skill in the top-10", (t) => {
  const idx = corpus(t, ["business-website-skill"]);
  if (!idx) return;
  const names = top(idx, "招商");
  assert.ok(names.includes("business-website-skill"), `top-10: ${names.join(", ")}`);
});

test("corpus: 投标 finds business-website-skill in the top-10", (t) => {
  const idx = corpus(t, ["business-website-skill"]);
  if (!idx) return;
  const names = top(idx, "投标");
  assert.ok(names.includes("business-website-skill"), `top-10: ${names.join(", ")}`);
});

test("corpus: 高保真 HTML finds huashu-design or html-to-react in the top-10", (t) => {
  const idx = corpus(t, ["huashu-design", "html-to-react"]);
  if (!idx) return;
  const names = top(idx, "高保真 HTML");
  assert.ok(
    names.includes("huashu-design") || names.includes("html-to-react"),
    `top-10: ${names.join(", ")}`,
  );
});

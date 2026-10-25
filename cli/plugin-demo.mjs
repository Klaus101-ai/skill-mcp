#!/usr/bin/env node
// Demo: print exactly the text part plugin/skill-router-hint.ts would append
// to `system` for a query, plus the formation time in ms. Plain Node — no
// opencode, no plugin registration, no writes.
//
//   node cli/plugin-demo.mjs [query...]      default: «проверь договор поставки»
//
// The first hook call of a fresh process pays the one-time index build; it is
// shown separately as a warm-up so the printed formation time reflects the
// per-dispatch cost the 150 ms self-guard is about.
import { createContextHook } from "../plugin/hint.mjs";

const args = process.argv.slice(2);
const query = args.length > 0 ? args.join(" ") : "проверь договор поставки";

function makeEvent(text) {
  return {
    agent: "demo",
    system: [{ type: "text", text: "demo system preamble" }],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

const hook = createContextHook(); // default env, default config, real skill roots

// Warm-up: builds the index once (as the first model dispatch would).
const warmEvent = makeEvent("warm-up");
const warmStart = performance.now();
hook(warmEvent);
const warmMs = performance.now() - warmStart;

// The demo call itself: its result is what would be appended to `system`.
const event = makeEvent(query);
const start = performance.now();
hook(event);
const elapsed = performance.now() - start;

const added = event.system.slice(1);
console.log(`query: ${query}`);
console.log(`warm-up call (index build included): ${warmMs.toFixed(1)} ms`);
if (added.length === 0) {
  console.log("hint: (no part appended — no match, disabled, or over the 150 ms budget)");
} else {
  console.log("--- text part appended to system ---");
  console.log(added[0].text);
  console.log("---");
  console.log(`block length: ${added[0].text.length} chars (limit 1000)`);
  console.log(`formation time: ${elapsed.toFixed(1)} ms (budget 150)`);
}

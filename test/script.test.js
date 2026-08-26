"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseScript, tokenize, findPosition } = require("../lib/script");

test("parses sentences and keeps cues out of spoken words", () => {
  const parsed = parseScript("Welcome everyone.\n\n[PAUSE]\n\nToday we begin.\n[SLIDE: 2]\nNext topic.");
  assert.equal(parsed.wordCount, 7);
  assert.deepEqual(parsed.blocks.map((block) => block.type), ["speech", "cue", "speech", "cue", "speech"]);
  assert.equal(parsed.blocks[1].text, "PAUSE");
});

test("normalizes punctuation, case, and accents", () => {
  assert.deepEqual(tokenize("Café — TODAY'S update!"), ["cafe", "today's", "update"]);
});

test("keeps Cyrillic and Thai words for multilingual tracking", () => {
  assert.deepEqual(tokenize("Добре дошли!"), ["добре", "дошли"]);
  assert.deepEqual(tokenize("พร้อม ซ้อม"), ["พร้อม", "ซ้อม"]);
});

test("matches incomplete recognized speech near the expected position", () => {
  const parsed = parseScript("Today I want to talk about the future of blood cancer research and the progress we have made over the past decade.");
  const match = findPosition(parsed.words, "today want talk future blood cancer research progress made past decade", 0);
  assert.ok(match.position >= 10, `position was ${match.position}`);
  assert.ok(match.confidence >= 0.45, `confidence was ${match.confidence}`);
});

test("recovers after jumping to a distant section", () => {
  const prefix = Array.from({ length: 140 }, (_, i) => `setup${i}`).join(" ");
  const parsed = parseScript(`${prefix}. The closing message is patience courage and clarity.`);
  const match = findPosition(parsed.words, "closing message patience courage clarity", 4);
  assert.ok(match.position > 138, `position was ${match.position}`);
});

test("new speech advances even when a few words from the prior sentence remain", () => {
  const parsed = parseScript("Welcome. This is a quick demonstration of MMM Rehearsal. The script was prepared on my phone but the mirror remains clean and distraction free.");
  const match = findPosition(parsed.words, "demonstration of mmm rehearsal the script was prepared on my phone but mirror remains clean distraction free", 8);
  assert.ok(match.position >= 19, `position was ${match.position}`);
  assert.ok(match.confidence >= 0.55, `confidence was ${match.confidence}`);
});

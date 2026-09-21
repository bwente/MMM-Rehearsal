"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const translationsDir = path.join(__dirname, "..", "translations");
const expectedLanguages = ["bg", "da", "de", "en", "es", "fr", "hu", "nl", "ru", "th"];

test("all supported languages have exactly the English translation keys", () => {
  const english = JSON.parse(fs.readFileSync(path.join(translationsDir, "en.json"), "utf8"));
  const englishKeys = Object.keys(english).sort();
  const files = fs.readdirSync(translationsDir).filter((file) => file.endsWith(".json") && !file.startsWith("._")).map((file) => path.basename(file, ".json")).sort();
  assert.deepEqual(files, expectedLanguages);

  for (const language of expectedLanguages) {
    const translation = JSON.parse(fs.readFileSync(path.join(translationsDir, `${language}.json`), "utf8"));
    assert.deepEqual(Object.keys(translation).sort(), englishKeys, `${language}.json keys differ from English`);
    for (const key of englishKeys) assert.ok(String(translation[key]).trim(), `${language}.json has an empty ${key}`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
function extractFunction(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const candidates = [
    app.indexOf(`function ${nextName}(`, start),
    app.indexOf(`async function ${nextName}(`, start)
  ].filter(position => position >= 0);
  const end = candidates.length ? Math.min(...candidates) : -1;
  assert.ok(start >= 0 && end > start, `Could not locate ${name} in app.js`);
  return app.slice(start, end);
}
const mapStart = app.indexOf("const ARABIC_SPELLING_ALIASES = new Map([");
const mapEnd = app.indexOf("\nfunction normalizeArabicCorrectionToken", mapStart);
assert.ok(mapStart >= 0 && mapEnd > mapStart, "Could not locate Arabic spelling alias map");
const declarations = app.slice(mapStart, mapEnd);
const helpers = [
  extractFunction("normalizeArabicCorrectionToken", "arabicEditDistanceAtMostOne"),
  extractFunction("arabicEditDistanceAtMostOne", "getArabicSpellingSuggestion"),
  extractFunction("getArabicSpellingSuggestion", "updateArabicCorrectionSuggestion")
].join("\n");
const sandbox = { Map, module: { exports: {} } };
vm.runInNewContext(
  declarations + "\n" + helpers +
  "\nmodule.exports = { getArabicSpellingSuggestion, normalizeArabicCorrectionToken };",
  sandbox
);
const { getArabicSpellingSuggestion } = sandbox.module.exports;

test("suggests common Egyptian Arabic typo corrections without changing the original", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(getArabicSpellingSuggestion("ابحث عن موعد مبارة"))),
    { original: "مبارة", corrected: "مباراة", value: "ابحث عن موعد مباراة" }
  );
  assert.equal(getArabicSpellingSuggestion("مواعيد مباراة الأهلي القادمة"), null);
});

test("suggests common Egypt national team and club spelling fixes", () => {
  assert.equal(getArabicSpellingSuggestion("موعد منتخيب مصر")?.corrected, "منتخب");
  assert.equal(getArabicSpellingSuggestion("مباراة الاهلي")?.corrected, "الأهلي");
  assert.equal(getArabicSpellingSuggestion("جدول الزمالكك")?.corrected, "الزمالك");
});

test("offers unambiguous one-character suggestions for common words", () => {
  assert.equal(getArabicSpellingSuggestion("ابحت")?.corrected, "ابحث");
});

test("suggestions preserve punctuation and are not applied to the message automatically", () => {
  const suggestion = getArabicSpellingSuggestion("ميعاد مبارة،");
  assert.equal(suggestion?.value, "ميعاد مباراة،");
  assert.equal(getArabicSpellingSuggestion("كلمةغيرمعروفة"), null);
});

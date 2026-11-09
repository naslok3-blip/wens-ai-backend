import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const helperStart = worker.indexOf("function getEgyptCurrentDateTime()");
const helperEnd = worker.indexOf("async function executeAgentTool(", helperStart);
const normalizeStart = worker.indexOf("function normalizeLiveDataText(value)");
const normalizeEnd = worker.indexOf("\nfunction isEgyptGoldPriceRequest", normalizeStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "Egypt date/time helpers missing");
assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, "text normalizer missing");

const context = vm.createContext({ Intl, Date, String, RegExp });
vm.runInContext(
  worker.slice(normalizeStart, normalizeEnd) + "\n" +
  worker.slice(helperStart, helperEnd) +
  "\nmodule.exports = { getEgyptCurrentDateTime, getEgyptDateTimeIntent };",
  Object.assign(context, { module: { exports: {} } })
);
const { getEgyptCurrentDateTime, getEgyptDateTimeIntent } = context.module.exports;

test("current date/time is generated in Africa/Cairo, not UTC", () => {
  const value = getEgyptCurrentDateTime();
  assert.equal(value.timeZone, "Africa/Cairo");
  assert.match(value.localDateISO, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(value.localTime.length > 0);
  assert.ok(value.utcOffset.includes("GMT"));
  const expectedDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  assert.equal(value.localDateISO, expectedDate);
});

test("recognizes common Egyptian Arabic time questions", () => {
  for (const phrase of ["الساعه كام حاليا", "الساعة كام", "الوقت كام دلوقتي", "كم الساعة"]) {
    assert.equal(getEgyptDateTimeIntent(phrase).asksTime, true, phrase);
  }
});

test("recognizes common Egyptian Arabic date questions", () => {
  for (const phrase of ["النهارده كام", "النهاردة ايه", "اليوم ايه", "ايه تاريخ اليوم"]) {
    assert.equal(getEgyptDateTimeIntent(phrase).asksDate, true, phrase);
  }
});

test("does not classify unrelated questions as a clock request", () => {
  assert.deepEqual(
    { ...getEgyptDateTimeIntent("ازيك يا ونس") },
    { asksTime: false, asksDate: false, matched: false }
  );
});

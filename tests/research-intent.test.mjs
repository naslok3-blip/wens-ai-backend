import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

function extractFunction(name, nextName) {
  const start = worker.indexOf(`function ${name}(`);
  const candidates = [
    worker.indexOf(`function ${nextName}(`, start),
    worker.indexOf(`async function ${nextName}(`, start)
  ].filter(position => position >= 0);
  const end = candidates.length ? Math.min(...candidates) : -1;
  assert.ok(start >= 0 && end > start, `Could not locate ${name} in worker.js`);
  return worker.slice(start, end);
}

const helpers = [
  extractFunction("normalizeLiveDataText", "isEgyptGoldPriceRequest"),
  extractFunction("isEgyptGoldPriceRequest", "isLiveDataRequest"),
  extractFunction("isLiveDataRequest", "hasVerifiableLiveSources"),
  extractFunction("isExplicitExternalSearchRequest", "isExternalResearchIntent"),
  extractFunction("isExternalResearchIntent", "extractExternalSources"),
  extractFunction("hasVerifiableGoldPriceSources", "isExplicitExternalSearchRequest")
].join("\n");

const sandbox = { URL, module: { exports: {} } };
vm.runInNewContext(
  `${helpers}\nmodule.exports = { isExternalResearchIntent, hasVerifiableGoldPriceSources };`,
  sandbox
);
const { isExternalResearchIntent, hasVerifiableGoldPriceSources } = sandbox.module.exports;

test("does not search for greetings", () => {
  assert.equal(isExternalResearchIntent("ازيك يا ونس"), false);
  assert.equal(isExternalResearchIntent("شكرا يا ونس"), false);
});

test("searches for direct factual questions", () => {
  assert.equal(isExternalResearchIntent("ايه عاصمة اليابان؟"), true);
  assert.equal(isExternalResearchIntent("ممكن تقولي تاريخ حرب أكتوبر"), true);
});

test("searches for natural Egyptian research requests", () => {
  assert.equal(isExternalResearchIntent("عايز اعرف أحدث الموبايلات في مصر"), true);
  assert.equal(isExternalResearchIntent("آخر أخبار الذكاء الاصطناعي"), true);
  assert.equal(isExternalResearchIntent("الفرق بين iPhone وSamsung"), true);
});

test("searches for current prices and explicitly requested web research", () => {
  assert.equal(isExternalResearchIntent("سعر الذهب اليوم في مصر"), true);
  assert.equal(isExternalResearchIntent("ابحث عن أفضل مصادر تعلم البرمجة"), true);
});

test("does not misclassify create, edit, or update requests as research", () => {
  assert.equal(isExternalResearchIntent("اعمللي تطبيق لإدارة المحل"), false);
  assert.equal(isExternalResearchIntent("عدل الصورة وخلي الخلفية بيضاء"), false);
  assert.equal(isExternalResearchIntent("ممكن تحدثي الموقع"), false);
});

test("Egypt gold verification rejects one source and non-EGP prices", () => {
  assert.equal(
    hasVerifiableGoldPriceSources("[سعر الذهب](https://one.example/gold) عيار 21: 2,200 جنيه اليوم"),
    false
  );
  assert.equal(
    hasVerifiableGoldPriceSources(
      "[سعر الذهب](https://one.example/gold) عيار 21: 2,200 USD اليوم\n" +
      "[سعر الذهب](https://two.example/gold) عيار 21: 2,210 USD اليوم"
    ),
    false
  );
});

test("Egypt gold verification accepts two independent, current EGP sources", () => {
  assert.equal(
    hasVerifiableGoldPriceSources(
      "[سعر الذهب](https://one.example/gold) عيار 21: 2,200 جنيه اليوم آخر تحديث 10:30\n" +
      "[سعر الذهب](https://two.example/gold) عيار 21: 2,210 EGP اليوم آخر تحديث 10:35"
    ),
    true
  );
});

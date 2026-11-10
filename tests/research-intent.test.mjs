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
  extractFunction("isLiveDataRequest", "isSportsScheduleRequest"),
  extractFunction("isSportsScheduleRequest", "hasVerifiableLiveSources"),
  extractFunction("hasVerifiableLiveSources", "hasVerifiableSportsScheduleSources"),
  extractFunction("isExplicitExternalSearchRequest", "isExternalResearchIntent"),
  extractFunction("isExternalResearchIntent", "extractExternalSources"),
  extractFunction("buildExternalSearchQuery", "extractExternalSources"),
  extractFunction("extractExternalSources", "handleAgent"),
  extractFunction("getCurrentEgyptFootballSeason", "hasVerifiableSportsScheduleSources"),
  extractFunction("hasVerifiableSportsScheduleSources", "hasVerifiableGoldPriceSources"),
  extractFunction("hasVerifiableGoldPriceSources", "isExplicitExternalSearchRequest")
].join("\n");

const sandbox = { URL, atob, Date, module: { exports: {} } };
vm.runInNewContext(
  `${helpers}\nmodule.exports = { isExternalResearchIntent, isSportsScheduleRequest, getCurrentEgyptFootballSeason, hasVerifiableSportsScheduleSources, hasVerifiableGoldPriceSources, extractExternalSources, buildExternalSearchQuery };`,
  sandbox
);
const { isExternalResearchIntent, isSportsScheduleRequest, getCurrentEgyptFootballSeason, hasVerifiableSportsScheduleSources, hasVerifiableGoldPriceSources, extractExternalSources, buildExternalSearchQuery } = sandbox.module.exports;

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
    hasVerifiableGoldPriceSources({ results: "[سعر الذهب](https://one.example/gold) عيار 21: 2,200 جنيه اليوم" }),
    false
  );
  assert.equal(
    hasVerifiableGoldPriceSources({ results:
      "[سعر الذهب](https://one.example/gold) عيار 21: 2,200 USD اليوم\n" +
      "[سعر الذهب](https://two.example/gold) عيار 21: 2,210 USD اليوم"
    }),
    false
  );
});

test("Egypt gold verification accepts two independent, current EGP sources", () => {
  assert.equal(
    hasVerifiableGoldPriceSources({ results:
      "[سعر الذهب](https://one.example/gold) عيار 21: 2,200 جنيه اليوم آخر تحديث 10:30\n" +
      "[سعر الذهب](https://two.example/gold) عيار 21: 2,210 EGP اليوم آخر تحديث 10:35"
    }),
    true
  );
});

test("recognizes the exact explicit search request from chat", () => {
  assert.equal(
    isExternalResearchIntent("ايه عاصمة اليابان؟ ابحث في المواقع الخارجية واعرض المصادر داخل الشات."),
    true
  );
});

test("extracts original links from DuckDuckGo and Google redirects", () => {
  const sources = extractExternalSources({
    results:
      "[Example](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle)\n" +
      "[Reference](https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fguide)"
  });
  assert.equal(
    sources.map(item => item.url).join("|"),
    "https://example.com/article|https://example.org/guide"
  );
});

test("extracts source links from HTML and structured search responses", () => {
  const htmlSources = extractExternalSources({
    results: '<a href="https://example.net/page">Example Net</a>'
  });
  assert.equal(htmlSources[0]?.domain, "example.net");
  const structured = extractExternalSources({
    sources: [{ title: "Example Source", url: "https://example.edu/reference" }]
  });
  assert.equal(structured[0]?.url, "https://example.edu/reference");
});

test("removes search-interface instructions before querying engines", () => {
  assert.equal(
    buildExternalSearchQuery("ايه عاصمة اليابان؟ ابحث في المواقع الخارجية واعرض المصادر داخل الشات."),
    "ايه عاصمة اليابان"
  );
  assert.equal(
    buildExternalSearchQuery("ابحث عن أفضل مصادر تعلم البرمجة"),
    "أفضل مصادر تعلم البرمجة"
  );
});

test("recognizes Egyptian football fixture and league schedule requests", () => {
  assert.equal(isSportsScheduleRequest("مواعيد مباريات الأهلي في الدوري المصري الممتاز"), true);
  assert.equal(isSportsScheduleRequest("جدول مباريات الدوري المصري"), true);
  assert.equal(isSportsScheduleRequest("ما هي كرة القدم؟"), false);
});

test("rejects old-season league schedules even when they contain dates and links", () => {
  const result = {
    results:
      "[مواعيد الأهلي 2024-25](https://one.example/fixtures) جدول مباريات الأهلي موسم 2024-25 اليوم آخر تحديث 10:30\n" +
      "[جدول الدوري 2024-25](https://two.example/league) مباريات الدوري المصري 2024-25 اليوم منشور"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});

test("requires two independent fresh sources mentioning the current season for sports fixtures", () => {
  const year = new Date().getUTCFullYear();
  const next = year + 1;
  const season = year + "-" + next;
  const result = {
    results:
      "[جدول الدوري المصري " + season + "](https://one.example/fixtures) مواعيد مباريات الأهلي موسم " + season + " اليوم آخر تحديث 10:30\n\n" +
      "[مباريات الأهلي " + season + "](https://two.example/alahly) جدول الدوري موسم " + season + " منشور اليوم"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), true);
});

test("rejects a one-source current-season fixture even if the page is fresh", () => {
  const year = new Date().getUTCFullYear();
  const result = {
    results:
      "[جدول الدوري " + year + "](https://one.example/fixtures) مباريات الأهلي اليوم آخر تحديث 10:30"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});


test("rejects an old-season schedule even when an unrelated current year appears in the result", () => {
  const result = {
    results:
      "[جدول 2024-25](https://one.example/fixtures) مواعيد مباريات الأهلي موسم 2024-25 اليوم آخر تحديث 10:30\n" +
      "[خبر موسم 2026](https://two.example/news) خبر منشور في 2026 اليوم"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});

test("rejects old fixtures when a separate article merely mentions the current season", () => {
  const season = getCurrentEgyptFootballSeason();
  const result = {
    results:
      "[جدول الأهلي 2024-25](https://one.example/fixtures) مواعيد مباريات الأهلي موسم 2024-25 اليوم آخر تحديث 10:30\nالرابط: https://one.example/fixtures\n\n" +
      "خبر عام عن موسم " + season.short + " فقط، بلا تفاصيل\nالرابط: https://two.example/news"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});

test("current-season validator accepts the short season notation only with schedule evidence", () => {
  const season = getCurrentEgyptFootballSeason();
  const result = {
    results:
      "[جدول الدوري " + season.short + "](https://one.example/fixtures) مواعيد مباريات الأهلي موسم " + season.short + " اليوم آخر تحديث 10:30\n" +
      "[مباريات الأهلي " + season.short + "](https://two.example/alahly) جدول الدوري موسم " + season.short + " منشور اليوم"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  fromResponsesResponse,
  toResponsesInput,
  toResponsesTools
} from "../openai-responses-utils.mjs";

test("converts system/user messages and image attachments to Responses input", () => {
  const input = toResponsesInput([
    { role: "system", content: "Be Wens." },
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this." },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
      ]
    }
  ]);

  assert.deepEqual(input, [
    { role: "system", content: "Be Wens." },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Describe this." },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" }
      ]
    }
  ]);
});

test("converts assistant tool calls and tool outputs to Responses items", () => {
  const input = toResponsesInput([
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_123",
        type: "function",
        function: { name: "calculate", arguments: "{\"expression\":\"2+2\"}" }
      }]
    },
    { role: "tool", tool_call_id: "call_123", name: "calculate", content: "{\"result\":4}" }
  ]);

  assert.deepEqual(input, [
    {
      type: "function_call",
      call_id: "call_123",
      name: "calculate",
      arguments: "{\"expression\":\"2+2\"}"
    },
    {
      type: "function_call_output",
      call_id: "call_123",
      output: "{\"result\":4}"
    }
  ]);
});

test("converts Wens tool definitions to Responses function tools", () => {
  const tools = toResponsesTools([{
    type: "function",
    function: {
      name: "calculate",
      description: "Calculate safely.",
      parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] }
    }
  }]);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].name, "calculate");
  assert.equal(tools[0].strict, false);
  assert.deepEqual(tools[0].parameters.required, ["expression"]);
});

test("normalizes a Responses function call to the shape Wens already executes", () => {
  const normalized = fromResponsesResponse({
    id: "resp_123",
    model: "gpt-6.2-sol",
    output: [{
      type: "function_call",
      id: "fc_123",
      call_id: "call_123",
      name: "calculate",
      arguments: "{\"expression\":\"19*23\"}"
    }]
  });

  assert.equal(normalized.model, "gpt-6.2-sol");
  assert.equal(normalized.choices[0].message.content, "");
  assert.equal(normalized.choices[0].message.tool_calls[0].id, "call_123");
  assert.equal(normalized.choices[0].message.tool_calls[0].function.name, "calculate");
});

test("extracts text from Responses output when output_text convenience field is absent", () => {
  const normalized = fromResponsesResponse({
    output: [{
      type: "message",
      content: [
        { type: "output_text", text: "أهلًا " },
        { type: "output_text", text: "بيك!" }
      ]
    }]
  });

  assert.equal(normalized.choices[0].message.content, "أهلًا \nبيك!");
});


test("extracts OpenAI web-search text and source links from tool actions and citations", async () => {
  const { extractResponsesWebSearch } = await import("../openai-responses-utils.mjs");
  const parsed = extractResponsesWebSearch({
    output_text: "ملخص نتائج البحث",
    output: [
      {
        type: "web_search_call",
        action: {
          type: "search",
          sources: [
            { type: "url", title: "مصدر أول", url: "https://example.com/article" },
            { type: "url", title: "مصدر مكرر", url: "https://example.com/article" },
            { type: "url", title: "رابط غير آمن", url: "http://insecure.example/page" }
          ]
        }
      },
      {
        type: "message",
        content: [{
          type: "output_text",
          text: "ملخص نتائج البحث",
          annotations: [{
            type: "url_citation",
            title: "مصدر ثان",
            url: "https://example.org/reference",
            start_index: 0,
            end_index: 12
          }]
        }]
      }
    ]
  });

  assert.equal(parsed.text, "ملخص نتائج البحث");
  assert.deepEqual(parsed.sources, [
    { title: "مصدر أول", url: "https://example.com/article", domain: "example.com" },
    { title: "مصدر ثان", url: "https://example.org/reference", domain: "example.org" }
  ]);
});

test("returns an empty source list when OpenAI search has no citations", async () => {
  const { extractResponsesWebSearch } = await import("../openai-responses-utils.mjs");
  assert.deepEqual(extractResponsesWebSearch({ output_text: "لا توجد مصادر" }), {
    text: "لا توجد مصادر",
    sources: []
  });
});


test("worker uses the server-side Responses API for main chat when configured", async () => {
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const client = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(worker.includes('from "./openai-responses-utils.mjs"'), "Responses adapters must be imported by the Worker");
  assert.ok(worker.includes("async function runWensAgentTextModel"), "main agent provider adapter must exist");
  assert.ok(worker.includes("https://api.openai.com/v1/responses"), "main chat must call the Responses API server-side");
  assert.ok(worker.includes('if (!env.OPENAI_API_KEY) return runWensTextModel(env, model, options)'), "Workers AI remains the fallback when no API key is configured");
  assert.ok(worker.includes('env.WENS_OPENAI_MODEL || "gpt-6.2-sol"'), "default chat model must be a supported GPT-6 Sol model");
  assert.ok(worker.includes('env.WENS_OPENAI_REASONING_MODEL || "gpt-6.2-astra"'), "deep reasoning must use the GPT-6 Astra model");
  assert.ok(worker.includes("store: false"), "Responses requests must not be stored by the API");
  assert.ok(worker.includes('if (options.useWebSearch) tools.push({ type: "web_search" })'), "hosted web search must be available when external research is required");
  assert.ok(worker.includes("useWebSearch: requiresExternalSearch"), "external questions must enable hosted web search");
  assert.ok(worker.includes("محرك البحث الخارجي متعدد المصادر لم يثبت"), "hosted web search must be used before refusing unverified current information");
  assert.ok(worker.includes('reasoning: { effort: options.deepThink ? "high" : "medium" }'), "standard and deep requests must set supported reasoning effort");
  assert.ok(worker.includes("const useReasoningModel = deepThink || (!env.OPENAI_API_KEY && Boolean(imageBase64));"), "image understanding alone must not force the more expensive Astra model");
  assert.ok(worker.includes("Math.max(options.deepThink ? 3072 : 1200, requestedOutputTokens)"), "Responses output budget must leave room for reasoning and complete answers");
  assert.ok(worker.includes("openAIChatConfigured: Boolean(env.OPENAI_API_KEY)"), "health diagnostics must expose server-side API readiness");
  assert.ok(worker.includes("return await env.AI.run("), "Workers AI remains available for image and project tasks");
  assert.equal(client.includes("OPENAI_API_KEY"), false, "the API key must never be sent to browser code");
  assert.equal(client.includes("api.openai.com"), false, "browser code must not call OpenAI directly");
});


test("Responses adapter preserves citations from hosted web search", async () => {
  const { fromResponsesResponse } = await import("../openai-responses-utils.mjs");
  const parsed = fromResponsesResponse({
    id: "resp_search",
    model: "gpt-6.2-sol",
    output_text: "موعد المباراة يوم 29 نوفمبر.",
    output: [{
      type: "web_search_call",
      action: { sources: [{ title: "Official fixtures", url: "https://example.com/fixtures" }] }
    }]
  });
  assert.equal(parsed.output_text, "موعد المباراة يوم 29 نوفمبر.");
  assert.deepEqual(parsed.sources, [
    { title: "Official fixtures", url: "https://example.com/fixtures", domain: "example.com" }
  ]);
});

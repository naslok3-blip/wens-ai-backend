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


test("worker imports every OpenAI Responses adapter used by its chat path", async () => {
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const diagnosticsStart = worker.indexOf('path === "/api/admin/diagnostics" && request.method === "GET"');
  assert.ok(diagnosticsStart >= 0, "owner diagnostics route must exist");
  const diagnosticsSnippet = worker.slice(diagnosticsStart, diagnosticsStart + 5000);
  assert.match(diagnosticsSnippet, /openAI: Boolean\\(env\\.OPENAI_API_KEY\\)/);
  assert.doesNotMatch(diagnosticsSnippet, /openAI:\\s*false/);
  const adapterImport = worker.split("\n").find(line => line.includes('from "./openai-responses-utils.mjs"'));
  assert.ok(adapterImport, "worker.js must import the OpenAI Responses adapter module");
  for (const name of [
    "extractResponsesWebSearch",
    "fromResponsesResponse",
    "toResponsesInput",
    "toResponsesTools"
  ]) {
    assert.ok(adapterImport.includes(name), name + " must be imported by worker.js");
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeResponsesResult,
  runOpenAIResponses,
  toResponsesInput,
  toResponsesTools
} from "../openai-responses.mjs";

test("converts chat history, image input, and function outputs to Responses input items", () => {
  const input = toResponsesInput([
    { role: "system", content: "You are Wens." },
    { role: "user", content: [
      { type: "text", text: "What is in this image?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ] },
    { role: "assistant", content: "", tool_calls: [{
      id: "call_1", type: "function",
      function: { name: "calculate", arguments: "{\"expression\":\"2+2\"}" }
    }] },
    { role: "tool", tool_call_id: "call_1", name: "calculate", content: "{\"result\":4}" }
  ]);
  assert.equal(input[0].role, "system");
  assert.deepEqual(input[1].content, [
    { type: "input_text", text: "What is in this image?" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" }
  ]);
  assert.deepEqual(input[2], {
    type: "function_call", call_id: "call_1", name: "calculate",
    arguments: "{\"expression\":\"2+2\"}"
  });
  assert.deepEqual(input[3], {
    type: "function_call_output", call_id: "call_1", output: "{\"result\":4}"
  });
});

test("converts existing agent tool schemas to Responses function tools", () => {
  const tools = toResponsesTools([{
    type: "function",
    function: {
      name: "calculate", description: "Calculate safely",
      parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] }
    }
  }]);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].name, "calculate");
  assert.equal(tools[0].strict, false);
  assert.deepEqual(tools[0].parameters.required, ["expression"]);
});

test("normalizes Responses text and function calls for the existing Wens tool loop", () => {
  const result = normalizeResponsesResult({
    id: "resp_1", model: "gpt-6-luna",
    output: [
      { type: "message", content: [{ type: "output_text", text: "تم الحساب." }] },
      { type: "function_call", call_id: "call_2", name: "calculate", arguments: "{\"expression\":\"6*7\"}" }
    ]
  });
  assert.equal(result.model, "gpt-6-luna");
  assert.equal(result.choices[0].message.content, "تم الحساب.");
  assert.equal(result.choices[0].message.tool_calls[0].function.name, "calculate");
  assert.equal(result.choices[0].finish_reason, "tool_calls");
});

test("calls the Responses API with server-only auth and no stored response", async () => {
  let captured;
  const result = await runOpenAIResponses({
    apiKey: "test-secret",
    messages: [{ role: "user", content: "Hello" }],
    maxOutputTokens: 96,
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "resp_2", model: "gpt-6-luna",
        output: [{ type: "message", content: [{ type: "output_text", text: "أهلًا!" }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret");
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.max_output_tokens, 96);
  assert.equal(result.choices[0].message.content, "أهلًا!");
});

test("maps OpenAI quota errors to an actionable Arabic message", async () => {
  await assert.rejects(
    runOpenAIResponses({
      apiKey: "test-secret",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: "rate_limit_exceeded", message: "Too many requests" }
      }), { status: 429 })
    }),
    error => error.status === 429 && /حد الاستخدام أو الرصيد/.test(error.userMessage)
  );
});

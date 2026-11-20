import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeWorkersAiStream,
  createWensStreamResponse,
  jsonResponseAsWensStream,
  encodeWensSseEvent,
  extractWorkersAiDelta,
  parseWorkersAiSseFrame
} from "../stream-utils.mjs";

test("extracts Workers AI OpenAI-compatible chat deltas", () => {
  assert.equal(extractWorkersAiDelta({ choices: [{ delta: { content: "أهلًا" } }] }), "أهلًا");
  assert.equal(extractWorkersAiDelta({ result: { choices: [{ delta: { content: "ونس" } }] } }), "ونس");
});

test("extracts Workers AI text-generation response deltas", () => {
  assert.equal(extractWorkersAiDelta({ response: "مرحبا" }), "مرحبا");
  assert.equal(parseWorkersAiSseFrame('data: {"response":"مصر"}'), "مصر");
  assert.equal(parseWorkersAiSseFrame("data: [DONE]"), "");
});

test("consumes fragmented SSE frames and preserves Arabic and emoji", async () => {
  const encoder = new TextEncoder();
  const frames = [
    'data: {"choices":[{"delta":{"content":"أهل"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ًا 💜"}}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const bytes = encoder.encode(frames.join(""));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17, 42));
      controller.enqueue(bytes.slice(42));
      controller.close();
    }
  });
  const deltas = [];
  const reply = await consumeWorkersAiStream(stream, part => deltas.push(part));
  assert.equal(reply, "أهلًا 💜");
  assert.deepEqual(deltas, ["أهل", "ًا 💜"]);
});

test("encodes Wens events as valid server-sent events", () => {
  assert.equal(
    encodeWensSseEvent("delta", { text: "ونس" }),
    'event: delta\ndata: {"text":"ونس"}\n\n'
  );
});


test("streams Wens delta events and persists only the normalized final reply", async () => {
  const encoder = new TextEncoder();
  const provider = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"response":"Hello "}\n\n'));
      controller.enqueue(encoder.encode('data: {"response":"world"}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  let saved = "";
  const response = createWensStreamResponse(provider, {
    meta: { conversationId: "conversation-1" },
    done: { ok: true, model: "test-model" },
    normalize: value => value.trim(),
    onComplete: async value => { saved = value; }
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const payload = await response.text();
  assert.match(payload, /event: meta/);
  assert.match(payload, /event: delta/);
  assert.match(payload, /"text":"Hello "/);
  assert.match(payload, /"text":"world"/);
  assert.match(payload, /event: done/);
  assert.match(payload, /"reply":"Hello world"/);
  assert.equal(saved, "Hello world");
});

test("wraps instant agent replies in the same client event contract", async () => {
  const response = await jsonResponseAsWensStream(
    new Response(JSON.stringify({ ok: true, reply: "رد فوري" }), {
      headers: { "Content-Type": "application/json" }
    }),
    { conversationId: "conversation-2" }
  );
  const payload = await response.text();
  assert.match(payload, /event: delta/);
  assert.match(payload, /"text":"رد فوري"/);
  assert.match(payload, /"conversationId":"conversation-2"/);
  assert.match(payload, /event: done/);
});

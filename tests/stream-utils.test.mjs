import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeWorkersAiStream,
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

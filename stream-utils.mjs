const encoder = new TextEncoder();

export function extractWorkersAiDelta(payload) {
  if (!payload || typeof payload !== "object") return "";
  const choice = payload.choices?.[0] || payload.result?.choices?.[0];
  const candidates = [
    choice?.delta?.content,
    choice?.delta?.text,
    choice?.text,
    payload.response,
    payload.result?.response,
    payload.delta?.content,
    payload.delta?.text,
    payload.delta
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value)) {
      const text = value.map(item => typeof item === "string" ? item : typeof item?.text === "string" ? item.text : "").join("");
      if (text) return text;
    }
  }
  return "";
}

export function parseWorkersAiSseFrame(frame) {
  const data = String(frame || "").split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return "";
  try {
    return extractWorkersAiDelta(JSON.parse(data));
  } catch {
    return "";
  }
}

export function encodeWensSseEvent(event, payload) {
  return "event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
}

export async function consumeWorkersAiStream(readable, onDelta = () => {}) {
  if (!readable || typeof readable.getReader !== "function") {
    throw new TypeError("Workers AI streaming did not return a ReadableStream.");
  }
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  const processFrame = frame => {
    const delta = parseWorkersAiSseFrame(frame);
    if (!delta) return;
    output += delta;
    onDelta(delta);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
        buffer = buffer.slice(boundary + separator.length);
        processFrame(frame);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processFrame(buffer);
  } finally {
    reader.releaseLock();
  }
  return output;
}

export function createWensStreamResponse(providerStream, options = {}) {
  let reader;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(encodeWensSseEvent("meta", options.meta || {})));
      (async () => {
        const reply = await consumeWorkersAiStream(providerStream, delta => {
          controller.enqueue(encoder.encode(encodeWensSseEvent("delta", { text: delta })));
        });
        if (!reply.trim()) throw new Error("لم يصل نص من بث نموذج الذكاء الاصطناعي.");
        const finalReply = typeof options.normalize === "function" ? options.normalize(reply) : reply.trim();
        if (!finalReply) throw new Error("لم يصل رد نصي نهائي من نموذج الذكاء الاصطناعي.");
        if (typeof options.onComplete === "function") await options.onComplete(finalReply);
        controller.enqueue(encoder.encode(encodeWensSseEvent("done", { ...(options.done || {}), reply: finalReply })));
        controller.close();
      })().catch(error => {
        const failure = typeof options.onError === "function" ? options.onError(error) : null;
        controller.enqueue(encoder.encode(encodeWensSseEvent("error", {
          error: failure?.message || String(error?.message || "تعذّر إكمال الرد المباشر."),
          code: failure?.code || "STREAM_FAILED"
        })));
        controller.close();
      });
    },
    cancel(reason) {
      try { reader?.cancel(reason); } catch {}
    }
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

export async function jsonResponseAsWensStream(response, extra = {}) {
  let payload = {};
  try { payload = await response.json(); } catch {}
  const status = response.status || 200;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(encodeWensSseEvent("meta", extra)));
      if (!response.ok) {
        controller.enqueue(encoder.encode(encodeWensSseEvent("error", {
          error: payload.error || "تعذّر تنفيذ الطلب.",
          code: payload.code || "REQUEST_FAILED",
          status
        })));
      } else {
        const reply = String(payload.reply || "");
        if (reply) controller.enqueue(encoder.encode(encodeWensSseEvent("delta", { text: reply })));
        controller.enqueue(encoder.encode(encodeWensSseEvent("done", { ...payload, ...extra, reply })));
      }
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Accel-Buffering": "no"
    }
  });
}

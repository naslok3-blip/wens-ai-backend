const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function normalizeContent(content) {
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map(part => {
    if (!part || typeof part !== "object") return { type: "input_text", text: String(part ?? "") };
    if (part.type === "text" || part.type === "input_text") return { type: "input_text", text: String(part.text || "") };
    if (part.type === "image_url") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      return imageUrl ? { type: "input_image", image_url: imageUrl } : null;
    }
    if (part.type === "input_image") return part;
    return { type: "input_text", text: String(part.text || "") };
  }).filter(Boolean);
}

export function toResponsesInput(messages = []) {
  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "tool") {
      if (message.tool_call_id) input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id),
        output: String(message.content ?? "")
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (typeof message.content === "string" && message.content.trim()) input.push({ role: "assistant", content: message.content });
      for (const call of message.tool_calls) {
        const fn = call?.function || call || {};
        const name = String(fn.name || "").trim();
        const callId = String(call?.id || call?.call_id || "").trim();
        if (!name || !callId) continue;
        let args = fn.arguments ?? call.arguments ?? {};
        if (typeof args !== "string") args = JSON.stringify(args);
        input.push({ type: "function_call", call_id: callId, name, arguments: args });
      }
      continue;
    }
    const role = ["system", "developer", "user", "assistant"].includes(message.role) ? message.role : "user";
    input.push({ role, content: normalizeContent(message.content) });
  }
  return input;
}

export function toResponsesTools(tools = []) {
  return tools.map(tool => {
    const fn = tool?.function || tool || {};
    return {
      type: "function",
      name: String(fn.name || ""),
      description: String(fn.description || ""),
      parameters: fn.parameters || { type: "object", properties: {} },
      strict: false
    };
  }).filter(tool => tool.name);
}

export function normalizeResponsesResult(data, fallbackModel = "") {
  const output = Array.isArray(data?.output) ? data.output : [];
  const textParts = [];
  const toolCalls = [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") textParts.push(part.text);
        else if (part?.type === "refusal" && typeof part.refusal === "string") textParts.push(part.refusal);
      }
    } else if (item?.type === "function_call" && item.name && item.call_id) {
      toolCalls.push({
        id: String(item.call_id),
        type: "function",
        function: {
          name: String(item.name),
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      });
    }
  }
  const content = textParts.join("\n").trim() || String(data?.output_text || "").trim();
  return {
    id: data?.id || "",
    model: data?.model || fallbackModel,
    choices: [{
      message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? "tool_calls" : "stop"
    }]
  };
}

function openAiUserMessage(status, providerMessage) {
  if (status === 401 || status === 403) return "مفتاح OpenAI غير صالح أو غير مصرح له باستخدام النموذج. راجع إعداد المفتاح في Cloudflare Secrets.";
  if (status === 429) return "وصل حساب OpenAI API إلى حد الاستخدام أو الرصيد المتاح. راجع الفوترة وحدود الاستخدام في حساب OpenAI.";
  if (status === 404) return "نموذج GPT المحدد غير متاح لهذا المفتاح. راجع اسم النموذج أو صلاحية الوصول إليه.";
  if (status >= 500) return "خدمة OpenAI مشغولة حاليًا. حاول مرة أخرى بعد قليل.";
  return providerMessage || "تعذّر إكمال طلب OpenAI.";
}

export async function runOpenAIResponses({
  apiKey,
  model = "gpt-6-luna",
  messages = [],
  tools = [],
  maxOutputTokens = 1200,
  reasoningEffort,
  fetchImpl = fetch
} = {}) {
  if (!String(apiKey || "").trim()) throw new Error("مفتاح OpenAI غير مضبوط على الخادم.");
  const body = {
    model,
    input: toResponsesInput(messages),
    max_output_tokens: Math.max(64, Math.min(12000, Number(maxOutputTokens) || 1200)),
    store: false
  };
  if (tools.length) {
    body.tools = toResponsesTools(tools);
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  if (["low", "medium", "high"].includes(reasoningEffort)) body.reasoning = { effort: reasoningEffort };
  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    const error = new Error("تعذّر الاتصال بخدمة OpenAI من الخادم.");
    error.status = 503;
    error.code = "OPENAI_NETWORK_ERROR";
    error.userMessage = "تعذّر الاتصال بخدمة OpenAI حاليًا. حاول مرة أخرى بعد قليل.";
    throw error;
  }
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const providerMessage = String(data?.error?.message || "").replace(/\s+/g, " ").slice(0, 220);
    const error = new Error("OpenAI API request failed (" + response.status + ").");
    error.status = response.status;
    error.code = String(data?.error?.code || "OPENAI_API_ERROR").slice(0, 80);
    error.userMessage = openAiUserMessage(response.status, providerMessage);
    throw error;
  }
  if (data?.status === "failed" || data?.error) {
    const error = new Error("OpenAI returned a failed response.");
    error.status = 502;
    error.code = String(data?.error?.code || "OPENAI_RESPONSE_FAILED").slice(0, 80);
    error.userMessage = "وصل رد غير مكتمل من OpenAI. حاول مرة أخرى.";
    throw error;
  }
  return normalizeResponsesResult(data, model);
}

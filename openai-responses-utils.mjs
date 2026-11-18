// Adapters between Wens' existing Chat Completions-shaped agent loop and
// the OpenAI Responses API. Keeping the adapter isolated lets the agent's
// tools, history, and UI remain provider-agnostic.
export function toResponsesInput(messages) {
  const input = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "tool") {
      const callId = String(message.tool_call_id || "").trim();
      if (!callId) continue;
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: String(message.content ?? "")
      });
      continue;
    }

    const role = ["system", "developer", "user", "assistant"].includes(message.role)
      ? message.role
      : "user";

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      const content = typeof message.content === "string" ? message.content : "";
      if (content.trim()) input.push({ role: "assistant", content });
      for (const call of message.tool_calls) {
        const fn = call?.function || {};
        const callId = String(call?.id || call?.call_id || "").trim();
        const name = String(fn.name || call?.name || "").trim();
        if (!callId || !name) continue;
        const rawArguments = fn.arguments ?? call?.arguments ?? {};
        const args = typeof rawArguments === "string"
          ? rawArguments
          : JSON.stringify(rawArguments ?? {});
        input.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: args
        });
      }
      continue;
    }

    let content = message.content ?? "";
    if (Array.isArray(content)) {
      content = content.map(part => {
        if (!part || typeof part !== "object") return { type: "input_text", text: String(part ?? "") };
        if (part.type === "text" || part.type === "input_text") {
          return { type: "input_text", text: String(part.text || "") };
        }
        if (part.type === "image_url") {
          const imageUrl = typeof part.image_url === "string"
            ? part.image_url
            : String(part.image_url?.url || "");
          return imageUrl ? { type: "input_image", image_url: imageUrl } : null;
        }
        if (part.type === "input_image") return part;
        return { type: "input_text", text: String(part.text || "") };
      }).filter(Boolean);
    } else {
      content = String(content);
    }

    input.push({ role, content });
  }

  return input;
}

export function toResponsesTools(tools) {
  return (Array.isArray(tools) ? tools : []).map(tool => {
    const fn = tool?.function;
    if (tool?.type !== "function" || !fn?.name || !fn?.parameters) return null;
    return {
      type: "function",
      name: String(fn.name),
      description: String(fn.description || ""),
      parameters: fn.parameters,
      strict: false
    };
  }).filter(Boolean);
}

export function fromResponsesResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const text = typeof response?.output_text === "string"
    ? response.output_text.trim()
    : output
      .filter(item => item?.type === "message" && Array.isArray(item.content))
      .flatMap(item => item.content
        .filter(part => part?.type === "output_text" && typeof part.text === "string")
        .map(part => part.text))
      .join("\n")
      .trim();

  const calls = output
    .filter(item => item?.type === "function_call")
    .map((item, index) => ({
      id: String(item.call_id || item.id || "wens_response_call_" + index),
      type: "function",
      function: {
        name: String(item.name || ""),
        arguments: typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {})
      }
    }))
    .filter(call => call.function.name);

  return {
    id: response?.id,
    model: response?.model,
    output_text: text,
    choices: [{
      message: {
        role: "assistant",
        content: text,
        ...(calls.length ? { tool_calls: calls } : {})
      }
    }]
  };
}

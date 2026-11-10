const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/i;
const DEFAULT_ALLOWED_TOOLS = new Set([
  "get_current_time", "calculate", "search_web", "open_webpage",
  "browser_open", "browser_inspect", "browser_click", "browser_fill",
  "browser_close", "save_task", "list_tasks", "update_task",
  "set_task_status", "archive_task", "restore_task", "search_my_messages",
  "generate_image", "edit_image", "create_web_project", "list_web_projects",
  "edit_web_project", "list_web_project_revisions",
  "restore_web_project_revision", "save_memory", "list_memories", "delete_memory"
]);

function decodeBasicEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanArgumentValue(value) {
  return decodeBasicEntities(String(value || "")
    .replace(/<\s*\/?\s*arg_value\b[^>]*>/gi, "")
    .replace(/<\s*\/?\s*arg_key\b[^>]*>/gi, "")
    .replace(/<\s*\/?\s*arg\b[^>]*>/gi, "")
    .replace(/<\s*\/?\s*tool_call\b[^>]*>/gi, "")
    .replace(/<\s*\/\s*tool_call\s*>/gi, "")
    .replace(/<<\s*\/\s*tool_call\s*>?/gi, "")
    .replace(/<\|[^|]{1,80}\|>/g, "")
    .trim()).slice(0, 3200);
}

function parseCallBody(body, allowed) {
  const source = String(body || "").trim();
  if (!source) return null;

  if (source.startsWith("{")) {
    try {
      const parsed = JSON.parse(source);
      const name = String(parsed.name || parsed.tool || parsed.function?.name || "");
      const args = parsed.arguments ?? parsed.args ?? parsed.function?.arguments ?? {};
      if (!TOOL_NAME_PATTERN.test(name) || !allowed.has(name)) return null;
      const normalized = typeof args === "string" ? JSON.parse(args) : args;
      if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return null;
      return { name, arguments: normalized };
    } catch {}
  }

  const nameMatch = source.match(/^([a-z][a-z0-9_]*)/i);
  const name = nameMatch?.[1] || "";
  if (!TOOL_NAME_PATTERN.test(name) || !allowed.has(name)) return null;

  const args = {};
  const keyPattern = /<\s*arg_key\s*>\s*([a-z][a-z0-9_]*)\s*<\s*\/\s*(?:arg_key|arg)\s*>/gi;
  const keys = [...source.matchAll(keyPattern)];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index][1];
    const valueStart = keys[index].index + keys[index][0].length;
    const nextKeyStart = keys[index + 1]?.index ?? source.length;
    const raw = source.slice(valueStart, nextKeyStart);
    // Some model versions wrap values in <arg_value>...</arg_value>; others
    // close them with an empty <arg_value/> token. Accept both forms.
    const openValue = raw.match(/<\s*arg_value\s*>([\s\S]*?)(?:<\s*\/\s*arg_value\s*>|$)/i);
    const value = cleanArgumentValue(openValue ? openValue[1] : raw);
    if (value) args[key] = value;
  }

  if (name === "search_web" && !args.query) {
    const fallback = cleanArgumentValue(source.slice(nameMatch[0].length).replace(/<\s*arg_key\b[\s\S]*$/i, ""));
    if (fallback.length > 3 && !/^(?:query|arg_value)$/i.test(fallback)) args.query = fallback;
  }
  return Object.keys(args).length ? { name, arguments: args } : null;
}

/**
 * Parse tool calls emitted as text by models that fail to return the native
 * tool_calls JSON field. Supports JSON-in-tag and tolerant arg_key/arg_value
 * variants, including the malformed "tool_call>" prefix seen in production.
 */
export function parseTextToolCalls(value, allowedNames = DEFAULT_ALLOWED_TOOLS) {
  const text = String(value || "").slice(0, 16000);
  if (!/(?:<\s*tool_call\b|(?:^|\n)\s*tool_call\s*>|<\|tool_call\|>)/i.test(text)) return [];
  const allowed = allowedNames instanceof Set ? allowedNames : new Set(allowedNames || []);
  const starts = [...text.matchAll(/<\s*tool_call\b[^>]*>|(?:^|\n)\s*tool_call\s*>|<\|tool_call\|>/gi)];
  const calls = [];
  for (let index = 0; index < starts.length && calls.length < 6; index++) {
    const bodyStart = starts[index].index + starts[index][0].length;
    const nextStart = starts[index + 1]?.index ?? text.length;
    const rest = text.slice(bodyStart, nextStart);
    const close = /(?:<\s*\/\s*tool_call\s*>|<<\s*\/\s*tool_call\s*>?|<\|tool_call_end\|>)/i.exec(rest);
    const body = close ? rest.slice(0, close.index) : rest;
    const parsed = parseCallBody(body, allowed);
    if (parsed && !calls.some(call => call.name === parsed.name &&
      JSON.stringify(call.arguments) === JSON.stringify(parsed.arguments))) {
      calls.push(parsed);
    }
  }
  return calls;
}

export function containsToolCallMarkup(value) {
  return /(?:<\s*tool_call\b|(?:^|\n)\s*tool_call\s*>|<\|tool_call\|>|<\s*arg_key\s*>|<\s*arg_value\b)/i.test(String(value || ""));
}

/** Never send model-internal tool syntax to the chat UI or conversation history. */
export function stripToolCallMarkup(value) {
  let text = String(value ?? "");
  const startPattern = /<\s*tool_call\b[^>]*>|(?:^|\n)\s*tool_call\s*>|<\|tool_call\|>/gi;
  const starts = [...text.matchAll(startPattern)];
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i].index;
    const bodyStart = start + starts[i][0].length;
    const nextStart = starts[i + 1]?.index ?? text.length;
    const tail = text.slice(bodyStart, nextStart);
    const close = /(?:<\s*\/\s*tool_call\s*>|<<\s*\/\s*tool_call\s*>?|<\|tool_call_end\|>)/i.exec(tail);
    const end = close ? bodyStart + close.index + close[0].length : nextStart;
    text = text.slice(0, start) + " " + text.slice(end);
  }
  text = text
    .replace(/<\s*arg_key\s*>[\s\S]*?(?=<\s*arg_key\s*>|$)/gi, " ")
    .replace(/<\s*\/?\s*arg_value\b[^>]*>/gi, " ")
    .replace(/<\s*\/?\s*arg_key\b[^>]*>/gi, " ")
    .replace(/<\s*\/?\s*arg\b[^>]*>/gi, " ")
    .replace(/<\|(?:tool_call|tool_call_end)\|>/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

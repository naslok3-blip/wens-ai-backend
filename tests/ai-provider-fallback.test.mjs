import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCloudflareFallbackOptions,
  selectCloudflareFallbackModel,
  shouldFallbackToCloudflareAI
} from "../ai-provider-fallback.mjs";

test("falls back for OpenAI quota exhaustion and rate limiting", () => {
  assert.equal(shouldFallbackToCloudflareAI(new Error("OPENAI_API_HTTP_429_insufficient_quota")), true);
  assert.equal(shouldFallbackToCloudflareAI(new Error("rate_limit_exceeded")), true);
  assert.equal(shouldFallbackToCloudflareAI(new Error("billing_hard_limit")), true);
});

test("falls back for temporary OpenAI outages, but not for invalid credentials or permissions", () => {
  assert.equal(shouldFallbackToCloudflareAI(new Error("OPENAI_API_HTTP_503_server_error")), true);
  assert.equal(shouldFallbackToCloudflareAI(new Error("fetch failed")), true);
  assert.equal(shouldFallbackToCloudflareAI(new Error("OPENAI_API_HTTP_401_invalid_api_key")), false);
  assert.equal(shouldFallbackToCloudflareAI(new Error("OPENAI_API_HTTP_403_permission_denied")), false);
  assert.equal(shouldFallbackToCloudflareAI(new Error("model_not_found")), false);
});

test("selects the normal or reasoning Cloudflare model", () => {
  assert.equal(selectCloudflareFallbackModel({}), "@cf/zai-org/glm-4.7-flash");
  assert.equal(selectCloudflareFallbackModel({ WENS_AGENT_MODEL: "@cf/custom/chat" }), "@cf/custom/chat");
  assert.equal(selectCloudflareFallbackModel({}, { deepThink: true }), "@cf/qwen/qwen3.8-27b");
  assert.equal(
    selectCloudflareFallbackModel({ WENS_REASONING_MODEL: "@cf/custom/reasoning" }, { deepThink: true }),
    "@cf/custom/reasoning"
  );
});

test("removes OpenAI-only options and preserves native tools for Workers AI", () => {
  const tools = [{ type: "function", function: { name: "search_web" } }];
  const options = buildCloudflareFallbackOptions({
    messages: [{ role: "user", content: "hello" }],
    tools,
    deepThink: true,
    useWebSearch: true,
    max_tokens: 500
  }, "@cf/qwen/qwen3.8-27b");
  assert.deepEqual(options.tools, tools);
  assert.equal(options.reasoning_effort, "xhigh");
  assert.equal(options.useWebSearch, undefined);
  assert.equal(options.deepThink, undefined);
  assert.equal(options.max_tokens, 500);
});

test("enables thinking for the default Cloudflare chat model when requested", () => {
  const options = buildCloudflareFallbackOptions(
    { messages: [], deepThink: false, chat_template_kwargs: { custom_flag: true } },
    "@cf/zai-org/glm-4.7-flash"
  );
  assert.deepEqual(options.chat_template_kwargs, { custom_flag: true, enable_thinking: false });
});

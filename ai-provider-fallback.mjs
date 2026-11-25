export function shouldFallbackToCloudflareAI(error) {
  const raw = String(error?.message || error || "unknown");
  // Never hide authentication, permission, or model-access problems with a provider switch.
  if (/OPENAI_API_HTTP_401|OPENAI_API_HTTP_403|invalid_api_key|authentication_error|permission_denied|model_not_allowed|model_not_found/i.test(raw)) {
    return false;
  }
  // Fall back for exhausted quota / rate limits and temporary OpenAI outages.
  return /OPENAI_API_HTTP_429|OPENAI_API_HTTP_5\d\d|rate_limit_exceeded|insufficient_quota|billing_hard_limit|fetch failed|network error|connection error|timed? ?out/i.test(raw);
}

export function selectCloudflareFallbackModel(env = {}, options = {}) {
  const model = options.deepThink
    ? (env.WENS_REASONING_MODEL || "@cf/qwen/qwen3.8-27b")
    : (env.WENS_AGENT_MODEL || "@cf/zai-org/glm-4.7-flash");
  return String(model).trim();
}

export function buildCloudflareFallbackOptions(options = {}, model) {
  const { deepThink, useWebSearch, ...workerOptions } = options || {};
  // OpenAI's built-in web_search is not a Workers AI option. Wens's own
  // search_web tool remains in workerOptions.tools and can still be executed.
  void useWebSearch;

  if (model === "@cf/zai-org/glm-4.7-flash") {
    workerOptions.chat_template_kwargs = {
      ...(workerOptions.chat_template_kwargs || {}),
      enable_thinking: Boolean(deepThink)
    };
  }
  if (model === "@cf/qwen/qwen3.8-27b") {
    workerOptions.reasoning_effort = deepThink ? "xhigh" : "medium";
  }
  return workerOptions;
}

import test from "node:test";
import assert from "node:assert/strict";
import { conversationTitleFromMessage } from "../conversation-utils.mjs";

test("creates a readable title from the first user message", () => {
  assert.equal(conversationTitleFromMessage("اشرحلي الفرق بين الذكاء الاصطناعي والتعلم الآلي"), "اشرحلي الفرق بين الذكاء الاصطناعي والتعلم الآلي");
});

test("normalizes whitespace and removes null characters", () => {
  assert.equal(conversationTitleFromMessage("  اعمل\n\tلي\u0000 خطة   سفر  "), "اعمل لي خطة سفر");
});

test("uses a fallback title for empty messages", () => {
  assert.equal(conversationTitleFromMessage(" \n "), "محادثة جديدة");
});

test("truncates long titles without splitting Unicode characters", () => {
  const title = conversationTitleFromMessage("😀".repeat(80));
  assert.equal(Array.from(title).length, 56);
  assert.ok(title.endsWith("…"));
});

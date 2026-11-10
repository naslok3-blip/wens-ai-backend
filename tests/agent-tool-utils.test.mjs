import test from "node:test";
import assert from "node:assert/strict";
import {
  containsToolCallMarkup,
  parseTextToolCalls,
  stripToolCallMarkup
} from "../agent-tool-utils.mjs";

test("parses the malformed tool_call format seen in the mobile chat screenshot", () => {
  const raw = "الرد التمهيدي\n" +
    "tool_call>search_web<arg_key>query</arg>" +
    "مباريات الأهلي في الدوري المصري الممتاز 2024-25<arg_value/> << /tool_call";
  assert.equal(containsToolCallMarkup(raw), true);
  const calls = parseTextToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "search_web");
  assert.match(calls[0].arguments.query, /مباريات الأهلي في الدوري المصري الممتاز 2024-25/);
  assert.doesNotMatch(calls[0].arguments.query, /tool_call|arg_value/i);
});

test("parses tagged JSON tool calls without accepting unknown tools", () => {
  const raw = '<tool_call>{"name":"calculate","arguments":{"expression":"19 * 23"}}</tool_call>';
  assert.deepEqual(parseTextToolCalls(raw), [{
    name: "calculate",
    arguments: { expression: "19 * 23" }
  }]);
  assert.deepEqual(parseTextToolCalls('<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>'), []);
});

test("parses multiple argument keys and strips model protocol markup", () => {
  const raw = '<tool_call>browser_fill<arg_key>field</arg_key><arg_value>البحث</arg_value>' +
    '<arg_key>value</arg_key><arg_value>كلمة عادية</arg_value></tool_call>';
  const calls = parseTextToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { field: "البحث", value: "كلمة عادية" });
  assert.equal(stripToolCallMarkup("تم التنفيذ\n" + raw), "تم التنفيذ");
});

test("does not mistake ordinary assistant prose for a tool call", () => {
  const raw = "أقدر أبحث لك عن مباريات الأهلي ومواعيد الدوري.";
  assert.deepEqual(parseTextToolCalls(raw), []);
  assert.equal(containsToolCallMarkup(raw), false);
});

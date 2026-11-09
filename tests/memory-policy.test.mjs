import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf("function memorySafetyError(value) {");
const end = worker.indexOf("\nasync function handleUserMemoryTool", start);
assert.ok(start >= 0 && end > start, "memory safety policy function missing");
const sandbox = { String, RegExp };
const memorySafetyError = vm.runInNewContext(
  worker.slice(start, end) + "\nmemorySafetyError",
  sandbox
);

test("allows harmless user preferences and project facts", () => {
  assert.equal(memorySafetyError("يفضل الشرح باللهجة المصرية"), "");
  assert.equal(memorySafetyError("يعمل على مشروع محل دهانات"), "");
});

test("rejects passwords, tokens, and payment secrets", () => {
  for (const value of [
    "كلمة المرور الخاصة بي هي abc123",
    "OPENAI_API_KEY sk-secret-value",
    "رقم البطاقة CVV 123"
  ]) assert.ok(memorySafetyError(value), value);
});

test("rejects sensitive personal and health information", () => {
  for (const value of [
    "عندي مرض مزمن",
    "أستخدم دواء معين",
    "انتمائي السياسي",
    "عنوان البيت ورقم الهوية"
  ]) assert.ok(memorySafetyError(value), value);
});

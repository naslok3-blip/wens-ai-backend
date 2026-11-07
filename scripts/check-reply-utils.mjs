import assert from "node:assert/strict";
import { cleanRepeatedResponseText } from "../reply-utils.mjs";

const repeated = [
  "أقدر أعملك لعبة ماريو",
  "- أقدر أعملك لعبة ماريو",
  "- أقدر أعملك لعبة ماريو",
  "- أقدر أعملك لعبة ماريو",
  "",
  "هبدأ بنسخة بسيطة فيها حركة وقفز ونقاط."
].join("\n");
assert.equal(
  cleanRepeatedResponseText(repeated),
  "أقدر أعملك لعبة ماريو\n\nهبدأ بنسخة بسيطة فيها حركة وقفز ونقاط."
);
assert.equal(
  cleanRepeatedResponseText("تمام، هشرحلك الخطوات.\nالخطوة الأولى مختلفة.\nالخطوة التانية مختلفة."),
  "تمام، هشرحلك الخطوات.\nالخطوة الأولى مختلفة.\nالخطوة التانية مختلفة."
);
assert.equal(cleanRepeatedResponseText(""), "");
console.log("Repeated assistant reply cleanup tests passed.");

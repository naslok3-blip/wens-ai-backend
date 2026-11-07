export function cleanRepeatedResponseText(value) {
  const source = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return "";
  const seen = new Set();
  const output = [];
  let previousBlank = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/[ \t]+$/g, "");
    const trimmed = line.trim();
    if (!trimmed) {
      if (output.length && !previousBlank) output.push("");
      previousBlank = true;
      continue;
    }
    previousBlank = false;
    const key = trimmed
      .replace(/^(?:[-*•▪‣]\s+|\d+[.)]\s+)/u, "")
      .replace(/\s+/g, " ")
      .replace(/[.!؟،,;:؛]+$/u, "")
      .toLocaleLowerCase("ar");
    if (key.length >= 16) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    output.push(line);
  }
  return output.join("\n").trim();
}

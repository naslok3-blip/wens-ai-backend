export function conversationTitleFromMessage(value) {
  const normalized = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "محادثة جديدة";
  const characters = Array.from(normalized);
  return characters.length > 56
    ? characters.slice(0, 55).join("").trimEnd() + "…"
    : normalized;
}

const decoder = new TextDecoder("utf-8");
const latinDecoder = new TextDecoder("windows-1252");
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024;

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function xmlText(xml, tagPattern) {
  const output = [];
  for (const match of String(xml || "").matchAll(tagPattern)) {
    output.push(decodeEntities(match[1]));
  }
  return output.join("");
}

function safeBase64Bytes(data) {
  const maximumEncodedLength = Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4;
  if (typeof data !== "string" || !data.length || data.length > maximumEncodedLength || data.length % 4 !== 0) {
    throw new Error("حجم الملف فارغ أو يتجاوز 8 ميجابايت، أو أن ترميزه غير صالح.");
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const contentLength = data.length - padding;
  for (let i = 0; i < contentLength; i++) {
    const code = data.charCodeAt(i);
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!valid) throw new Error("بيانات الملف المشفرة غير صالحة.");
  }
  for (let i = contentLength; i < data.length; i++) {
    if (data.charCodeAt(i) !== 61) throw new Error("بيانات الملف المشفرة غير صالحة.");
  }
  const binary = atob(data);
  if (binary.length > 8 * 1024 * 1024) throw new Error("حجم الملف يتجاوز 8 ميجابايت.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function findZipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const count = view.getUint16(offset + 10, true);
      const directorySize = view.getUint32(offset + 12, true);
      const directoryOffset = view.getUint32(offset + 16, true);
      if (directoryOffset + directorySize > bytes.length || count > 2000) {
        throw new Error("فهرس ملف Office غير صالح أو أكبر من الحدود المسموحة.");
      }
      return { count, directoryOffset };
    }
  }
  throw new Error("الملف ليس أرشيف Office صالحًا أو يستخدم ZIP64 غير مدعوم.");
}

async function unzipEntries(bytes, wantedPaths) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = findZipDirectory(bytes);
  const wanted = new Set(wantedPaths);
  const found = new Map();
  let offset = directory.directoryOffset;
  let total = 0;

  for (let index = 0; index < directory.count; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("فهرس ملف Office تالف.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)).replace(/\\/g, "/");
    offset = nameStart + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) continue;
    if (flags & 1) throw new Error("الملف محمي بكلمة مرور ولا يمكن قراءته.");
    if (uncompressedSize > MAX_EXTRACTED_BYTES || total + uncompressedSize > MAX_EXTRACTED_BYTES) {
      throw new Error("حجم المحتوى المستخرج يتجاوز حد الأمان (4 ميجابايت).");
    }
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("بيانات أحد ملفات Office الداخلية غير صالحة.");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error("بيانات ملف Office ناقصة.");
    const compressed = bytes.subarray(dataStart, dataEnd);
    let extracted;
    if (method === 0) extracted = compressed.slice();
    else if (method === 8) {
      if (typeof DecompressionStream !== "function") {
        throw new Error("بيئة الخادم لا تدعم فك ضغط ملفات Office.");
      }
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      extracted = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error("طريقة ضغط داخلية غير مدعومة في ملف Office.");
    }
    if (extracted.length !== uncompressedSize || extracted.length > MAX_EXTRACTED_BYTES) {
      throw new Error("حجم الملف بعد فك الضغط غير متطابق أو تجاوز الحد.");
    }
    total += extracted.length;
    found.set(name, decoder.decode(extracted));
  }
  return found;
}

function extractDocx(entries) {
  const main = entries.get("word/document.xml");
  if (!main) throw new Error("ملف Word لا يحتوي على مستند نصي قابل للقراءة.");
  const xmlFiles = [...entries.entries()]
    .filter(([name]) => /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(name));
  const sections = [];
  for (const [name, xml] of xmlFiles) {
    const paragraphs = [];
    for (const paragraph of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gi)) {
      const text = xmlText(paragraph[0], /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)
        .replace(/<w:tab\b[^>]*\/>/gi, "\t")
        .replace(/<w:br\b[^>]*\/>/gi, "\n")
        .trim();
      if (text) paragraphs.push(text);
    }
    if (paragraphs.length) sections.push((name === "word/document.xml" ? "المستند" : name) + ":\n" + paragraphs.join("\n"));
  }
  const text = sections.join("\n\n").trim();
  if (!text) throw new Error("ملف Word لا يحتوي على نص مستخرج. قد يكون صورًا فقط.");
  return text;
}

function extractXlsx(entries) {
  const workbook = entries.get("xl/workbook.xml");
  const relationships = entries.get("xl/_rels/workbook.xml.rels");
  if (!workbook || !relationships) throw new Error("ملف Excel لا يحتوي على فهرس أوراق صالح.");
  const sharedXml = entries.get("xl/sharedStrings.xml") || "";
  const sharedStrings = [...sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/gi)]
    .map(match => xmlText(match[0], /<t\b[^>]*>([\s\S]*?)<\/t>/gi));
  const targets = new Map();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([A-Za-z:]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
    if (attrs.Id && attrs.Target && !String(attrs.Type || "").includes("external")) {
      const target = attrs.Target.startsWith("/") ? attrs.Target.slice(1) : "xl/" + attrs.Target.replace(/^(\.\.\/)+/, "");
      targets.set(attrs.Id, target.replace(/\\/g, "/"));
    }
  }
  const sheets = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([A-Za-z:]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
    const relationId = attrs["r:id"];
    const target = targets.get(relationId);
    if (!target || !entries.has(target)) continue;
    const xml = entries.get(target);
    const rows = [];
    for (const row of xml.matchAll(/<row\b[\s\S]*?<\/row>/gi)) {
      const cells = [];
      for (const cell of row[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attrs = Object.fromEntries([...cell[1].matchAll(/([A-Za-z:]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
        const value = cell[2].match(/<v>([\s\S]*?)<\/v>/i)?.[1] ?? "";
        let display = "";
        if (attrs.t === "s") display = sharedStrings[Number(value)] ?? "";
        else if (attrs.t === "inlineStr") display = xmlText(cell[2], /<t\b[^>]*>([\s\S]*?)<\/t>/gi);
        else if (attrs.t === "b") display = value === "1" ? "TRUE" : "FALSE";
        else display = decodeEntities(value);
        if (display !== "") cells.push((attrs.r || "") + "=" + display);
      }
      if (cells.length) rows.push(cells.join(" | "));
    }
    if (rows.length) sheets.push("ورقة: " + decodeEntities(attrs.name || target) + "\n" + rows.join("\n"));
  }
  const text = sheets.join("\n\n").trim();
  if (!text) throw new Error("لم يتم العثور على بيانات في أوراق Excel.");
  return text;
}

function extractPptx(entries) {
  const slides = [...entries.entries()]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a,b) => Number(a[0].match(/slide(\d+)/i)?.[1] || 0) - Number(b[0].match(/slide(\d+)/i)?.[1] || 0));
  const output = slides.map(([name, xml]) => {
    const text = xmlText(xml, /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi);
    return text ? name + ":\n" + text : "";
  }).filter(Boolean);
  if (!output.length) throw new Error("عرض PowerPoint لا يحتوي على نص قابل للاستخراج.");
  return output.join("\n\n");
}

function decodePdfLiteral(value) {
  let output = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") { output += ch; continue; }
    const next = value[++i];
    if (next === undefined) break;
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (next === "\n") {}
    else if (next === "\r") { if (value[i+1] === "\n") i++; }
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let count = 0; count < 2 && /[0-7]/.test(value[i+1] || ""); count++) octal += value[++i];
      output += String.fromCharCode(parseInt(octal, 8));
    } else output += next;
  }
  if (output.charCodeAt(0) === 0xfeff) {
    const units = [];
    for (let i = 2; i + 1 < output.length; i += 2) units.push(output.charCodeAt(i) * 256 + output.charCodeAt(i+1));
    return String.fromCharCode(...units);
  }
  return latinDecoder.decode(Uint8Array.from(output, char => char.charCodeAt(0)));
}

function decodePdfUtf16Hex(value) {
  const hex = String(value || "").replace(/[^0-9a-f]/gi, "");
  const units = [];
  for (let index = 0; index + 3 < hex.length; index += 4) {
    units.push(parseInt(hex.slice(index, index + 4), 16));
  }
  return String.fromCharCode(...units);
}

function decodePdfHexString(value, cmap) {
  const hex = String(value || "").replace(/\\s/g, "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (!hex) return "";
  if (cmap instanceof Map && cmap.size) {
    const lengths = [...new Set([...cmap.keys()].map(key => key.length))].sort((a, b) => b - a);
    let output = "";
    for (let offset = 0; offset < hex.length;) {
      let matched = false;
      for (const length of lengths) {
        const code = hex.slice(offset, offset + length);
        if (cmap.has(code)) {
          output += cmap.get(code);
          offset += length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        const fallbackLength = lengths[lengths.length - 1] || 2;
        const code = hex.slice(offset, offset + fallbackLength);
        output += decodePdfUtf16Hex(code);
        offset += code.length;
      }
    }
    return output;
  }
  if (hex.startsWith("FEFF")) return decodePdfUtf16Hex(hex.slice(4));
  if (hex.length >= 4 && hex.length % 4 === 0 && /^(?:00[0-9A-F]{2})+/i.test(hex)) {
    return decodePdfUtf16Hex(hex);
  }
  const bytes = [];
  for (let offset = 0; offset + 1 < hex.length; offset += 2) bytes.push(parseInt(hex.slice(offset, offset + 2), 16));
  return latinDecoder.decode(Uint8Array.from(bytes));
}

function parsePdfCMap(source) {
  const cmap = new Map();
  const text = String(source || "");
  for (const section of text.matchAll(/\\d+\\s+beginbfchar([\\s\\S]*?)endbfchar/gi)) {
    for (const pair of section[1].matchAll(/<([0-9a-f]+)>\\s*<([0-9a-f]+)>/gi)) {
      cmap.set(pair[1].toUpperCase(), decodePdfUtf16Hex(pair[2]));
    }
  }
  for (const section of text.matchAll(/\\d+\\s+beginbfrange([\\s\\S]*?)endbfrange/gi)) {
    const ranges = /<([0-9a-f]+)>\\s*<([0-9a-f]+)>\\s*(<([0-9a-f]+)>|\\[([\\s\\S]*?)\\])/gi;
    for (const range of section[1].matchAll(ranges)) {
      const first = parseInt(range[1], 16);
      const last = parseInt(range[2], 16);
      if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || last - first > 4096) continue;
      if (range[5] !== undefined) {
        const destinations = [...range[5].matchAll(/<([0-9a-f]+)>/gi)].map(item => item[1]);
        for (let offset = 0; offset <= last - first && offset < destinations.length; offset++) {
          const sourceCode = (first + offset).toString(16).toUpperCase().padStart(range[1].length, "0");
          cmap.set(sourceCode, decodePdfUtf16Hex(destinations[offset]));
        }
      } else {
        const destinationStart = parseInt(range[4], 16);
        for (let offset = 0; offset <= last - first; offset++) {
          const sourceCode = (first + offset).toString(16).toUpperCase().padStart(range[1].length, "0");
          const destination = (destinationStart + offset).toString(16).toUpperCase().padStart(range[4].length, "0");
          cmap.set(sourceCode, decodePdfUtf16Hex(destination));
        }
      }
    }
  }
  return cmap;
}

async function extractPdfFontMaps(bytes, raw) {
  const objects = new Map();
  const streams = new Map();
  for (const match of raw.matchAll(/(\\d+)\\s+\\d+\\s+obj\\b([\\s\\S]*?)endobj/g)) {
    const objectId = match[1];
    const body = match[2];
    objects.set(objectId, body);
    const streamMarker = body.indexOf("stream");
    if (streamMarker < 0) continue;
    const absoluteMarker = match.index + match[0].indexOf("stream");
    let streamStart = absoluteMarker + 6;
    if (raw[streamStart] === "\\r") streamStart++;
    if (raw[streamStart] === "\\n") streamStart++;
    const streamEnd = raw.indexOf("endstream", streamStart);
    if (streamEnd < 0 || streamEnd - streamStart > MAX_EXTRACTED_BYTES) continue;
    let dataEnd = streamEnd;
    if (raw[dataEnd - 1] === "\\n") dataEnd--;
    if (raw[dataEnd - 1] === "\\r") dataEnd--;
    let streamBytes = bytes.subarray(streamStart, dataEnd);
    if (/\\/FlateDecode\\b/.test(body.slice(0, streamMarker))) {
      try {
        const stream = new Blob([streamBytes]).stream().pipeThrough(new DecompressionStream("deflate"));
        streamBytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        continue;
      }
    }
    if (streamBytes.length <= MAX_EXTRACTED_BYTES) streams.set(objectId, latinDecoder.decode(streamBytes));
  }

  const fontCmapIds = new Map();
  for (const [objectId, body] of objects) {
    const match = body.match(/\\/ToUnicode\\s+(\\d+)\\s+\\d+\\s+R/);
    if (match) fontCmapIds.set(objectId, match[1]);
  }
  const cmaps = new Map();
  for (const [fontId, cmapId] of fontCmapIds) {
    const source = streams.get(cmapId);
    if (source) cmaps.set(fontId, parsePdfCMap(source));
  }

  const fontMaps = new Map();
  const registerFontEntries = dictionary => {
    for (const entry of String(dictionary || "").matchAll(/\\/([A-Za-z0-9_.+-]+)\\s+(\\d+)\\s+\\d+\\s+R/g)) {
      const cmap = cmaps.get(entry[2]);
      if (cmap?.size && !fontMaps.has(entry[1])) fontMaps.set(entry[1], cmap);
    }
  };
  for (const body of objects.values()) {
    for (const fontDictionary of body.matchAll(/\\/Font\\s*<<([\\s\\S]*?)>>/g)) registerFontEntries(fontDictionary[1]);
    const indirectFontDictionary = body.match(/\\/Font\\s+(\\d+)\\s+\\d+\\s+R/);
    if (indirectFontDictionary) registerFontEntries(objects.get(indirectFontDictionary[1]));
  }
  return fontMaps;
}

function pdfTextOperators(source, fontMaps = new Map()) {
  const blocks = String(source || "").match(/BT[\\s\\S]*?ET/g) || [];
  const output = [];
  const operator = /(\\(((?:\\\\.|[^\\\\)])*)\\)|<([0-9a-f\\s]+)>|\\[([\\s\\S]*?)\\])\\s*(Tj|TJ)\\b/gi;
  for (const block of blocks) {
    let match;
    while ((match = operator.exec(block))) {
      const before = block.slice(0, match.index);
      const fontMatches = [...before.matchAll(/\\/([A-Za-z0-9_.+-]+)\\s+[\\d.]+\\s+Tf/gi)];
      const fontName = fontMatches.at(-1)?.[1];
      const cmap = fontMaps.get(fontName) || (fontMaps.size === 1 ? fontMaps.values().next().value : null);
      if (match[2] !== undefined) {
        output.push(decodePdfLiteral(match[2]));
      } else if (match[3] !== undefined) {
        output.push(decodePdfHexString(match[3], cmap));
      } else {
        const strings = [...match[4].matchAll(/\\(((?:\\\\.|[^\\\\)])*)\\)|<([0-9a-f\\s]+)>/gi)]
          .map(item => item[1] !== undefined ? decodePdfLiteral(item[1]) : decodePdfHexString(item[2], cmap));
        output.push(strings.join(""));
      }
    }
  }
  return output.join(" ").replace(/\\s+/g, " ").trim();
}

async function extractPdf(bytes) {
  if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
    throw new Error("الملف لا يحمل ترويسة PDF صحيحة.");
  }
  const raw = latinDecoder.decode(bytes);
  const parts = [raw];
  const streamPattern = /<<(.*?)>>\s*stream\r?\n/g;
  let match;
  let total = 0;
  while ((match = streamPattern.exec(raw))) {
    const streamStart = streamPattern.lastIndex;
    const end = raw.indexOf("endstream", streamStart);
    if (end < 0 || end - streamStart > MAX_EXTRACTED_BYTES) continue;
    if (!/\/FlateDecode\b/.test(match[1])) continue;
    const compressed = bytes.subarray(streamStart, end);
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"));
      const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      total += decompressed.length;
      if (total > MAX_EXTRACTED_BYTES) throw new Error("PDF expansion limit");
      parts.push(latinDecoder.decode(decompressed));
    } catch {}
    streamPattern.lastIndex = end + 9;
  }
  const fontMaps = await extractPdfFontMaps(bytes, raw);
  const text = parts.map(part => pdfTextOperators(part, fontMaps)).filter(Boolean).join("\n").slice(0, 50000);
  if (!text) {
    throw new Error("لم أجد طبقة نصية قابلة للاستخراج في PDF. قد يكون الملف ممسوحًا ضوئيًا أو يستخدم ترميزًا غير مدعوم؛ OCR غير مفعّل في النسخة المجانية.");
  }
  return text;
}

export async function extractDocumentText(file) {
  const extension = String(file?.name || "").split(".").pop().toLowerCase();
  const bytes = safeBase64Bytes(file?.data || "");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
    throw new Error("حجم الملف فارغ أو يتجاوز 8 ميجابايت.");
  }
  let text = "";
  if (extension === "pdf") text = await extractPdf(bytes);
  else if (["docx", "xlsx", "pptx"].includes(extension)) {
    const wanted = extension === "docx"
      ? ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]
      : extension === "xlsx"
        ? ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", ...Array.from({length:40},(_,i)=>"xl/worksheets/sheet"+(i+1)+".xml")]
        : Array.from({length:80},(_,i)=>"ppt/slides/slide"+(i+1)+".xml");
    const entries = await unzipEntries(bytes, wanted);
    text = extension === "docx" ? extractDocx(entries) : extension === "xlsx" ? extractXlsx(entries) : extractPptx(entries);
  } else {
    throw new Error("الصيغ المجانية المدعومة هي PDF النصي وDOCX وXLSX وPPTX. ملفات DOC/XLS/PPT القديمة تحتاج تحويلًا إلى صيغة حديثة.");
  }
  text = String(text || "").replace(/\u0000/g,"").trim().slice(0,50000);
  if (!text) throw new Error("لم يتم استخراج نص صالح من الملف.");
  return { text, model: "wens-local-document-parser", characters: text.length, source: "local-free" };
}

import test from "node:test";
import assert from "node:assert/strict";
import { extractDocumentText } from "../document-utils.mjs";

function makeStoredZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

const asFile = (name, bytes) => ({
  name,
  data: Buffer.from(bytes).toString("base64")
});

test("extracts paragraphs from DOCX without a paid API", async () => {
  const zip = makeStoredZip({
    "word/document.xml":
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>ونس AI</w:t></w:r></w:p><w:p><w:r><w:t>قراءة مجانية</w:t></w:r></w:p></w:body></w:document>'
  });
  const result = await extractDocumentText(asFile("sample.docx", zip));
  assert.match(result.text, /ونس AI/);
  assert.match(result.text, /قراءة مجانية/);
  assert.equal(result.source, "local-free");
});

test("preserves Word table rows, columns, and blank cells", async () => {
  const zip = makeStoredZip({
    "word/document.xml":
      '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>قبل الجدول</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>الصنف</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>الكمية</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>فرشاة</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p><w:r><w:t>بعد الجدول</w:t></w:r></w:p></w:body></w:document>'
  });
  const result = await extractDocumentText(asFile("table.docx", zip));
  assert.ok(result.text.indexOf("قبل الجدول") < result.text.indexOf("جدول:"));
  assert.match(result.text, /الصنف \| الكمية/);
  assert.match(result.text, /فرشاة \| —/);
  assert.ok(result.text.indexOf("بعد الجدول") > result.text.indexOf("جدول:"));
});

test("preserves Excel blank cells, formulas, and date-formatted serials", async () => {
  const zip = makeStoredZip({
    "xl/workbook.xml":
      '<workbook xmlns:r="r"><workbookPr date1904="0"/><sheets><sheet name="المخزون" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml":
      '<sst><si><t>الصنف</t></si><si><t>الكمية</t></si><si><t>فرشاة</t></si></sst>',
    "xl/styles.xml":
      '<styleSheet><numFmts numFmtCount="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"/></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c><c r="C2" s="1"><f>DATE(2024,1,1)</f><v>45292</v></c></row></sheetData></worksheet>'
  });
  const result = await extractDocumentText(asFile("stock.xlsx", zip));
  assert.match(result.text, /المخزون/);
  assert.match(result.text, /A1=الصنف/);
  assert.match(result.text, /B2=12/);
  assert.match(result.text, /C1=—/);
  assert.match(result.text, /C2=45292 \(تاريخ Excel: 2024-01-01\) \[صيغة: DATE\(2024,1,1\)\]/);
});

test("extracts text from uncompressed text-layer PDFs", async () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\nBT\n(Wens AI test) Tj\nET\nendobj\n%%EOF", "binary");
  const result = await extractDocumentText(asFile("sample.pdf", pdf));
  assert.match(result.text, /Wens AI test/);
});

test("reports scanned PDFs honestly when no text layer exists", async () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF", "binary");
  await assert.rejects(
    extractDocumentText(asFile("scan.pdf", pdf)),
    /OCR غير مفعّل/
  );
});

test("extracts slide text from PPTX", async () => {
  const zip = makeStoredZip({
    "ppt/slides/slide1.xml":
      '<p:sld xmlns:a="a"><a:t>عنوان العرض</a:t><a:t>النقطة الأولى</a:t></p:sld>'
  });
  const result = await extractDocumentText(asFile("deck.pptx", zip));
  assert.match(result.text, /عنوان العرض/);
  assert.match(result.text, /النقطة الأولى/);
});

test("rejects legacy Office files rather than pretending they were read", async () => {
  await assert.rejects(
    extractDocumentText(asFile("old.doc", Buffer.from("not really a doc"))),
    /DOC\/XLS\/PPT القديمة/
  );
});

test("rejects oversized and malformed files", async () => {
  await assert.rejects(
    extractDocumentText(asFile("broken.docx", Buffer.from("not a zip"))),
    /أرشيف Office|فهرس ملف Office/
  );
  await assert.rejects(
    extractDocumentText({ name: "large.docx", data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }),
    /يتجاوز 8 ميجابايت/
  );
});

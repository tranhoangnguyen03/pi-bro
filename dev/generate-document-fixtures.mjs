#!/usr/bin/env node
// Deterministic generator for tiny document test fixtures (PDF, DOCX).
// Uses only Node standard library (node:zlib, node:fs, node:path) with zero dependencies.
import { crc32 } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(repoDir, "test", "fixtures", "documents");

function buildMinimalPdf(text) {
	const streamContent = text ? `BT /F1 12 Tf 72 712 Td (${text}) Tj ET` : "";
	const streamLength = Buffer.byteLength(streamContent);

	const header = "%PDF-1.4\n";
	const obj1 = "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
	const obj2 = "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n";
	const obj3 = "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n";
	const obj4 = `4 0 obj << /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
	const obj5 = "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n";

	const offset1 = Buffer.byteLength(header);
	const offset2 = offset1 + Buffer.byteLength(obj1);
	const offset3 = offset2 + Buffer.byteLength(obj2);
	const offset4 = offset3 + Buffer.byteLength(obj3);
	const offset5 = offset4 + Buffer.byteLength(obj4);
	const startxref = offset5 + Buffer.byteLength(obj5);

	const pad = (n) => String(n).padStart(10, "0");
	const xref = [
		"xref\n0 6\n",
		"0000000000 65535 f \n",
		`${pad(offset1)} 00000 n \n`,
		`${pad(offset2)} 00000 n \n`,
		`${pad(offset3)} 00000 n \n`,
		`${pad(offset4)} 00000 n \n`,
		`${pad(offset5)} 00000 n \n`,
	].join("");

	const trailer = `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
	return Buffer.from(header + obj1 + obj2 + obj3 + obj4 + obj5 + xref + trailer, "latin1");
}

function buildMinimalDocx(text) {
	const files = [
		{
			name: "[Content_Types].xml",
			content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
		},
		{
			name: "_rels/.rels",
			content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
		},
		{
			name: "word/document.xml",
			content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>${text}</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`,
		},
	];

	const localHeaders = [];
	const centralHeaders = [];
	let offset = 0;

	for (const { name, content } of files) {
		const data = Buffer.from(content);
		const nameBuf = Buffer.from(name);
		const crc = crc32(data);

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0x2121, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		nameBuf.copy(local, 30);

		localHeaders.push(local, data);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(0x2121, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);

		centralHeaders.push(central);
		offset += local.length + data.length;
	}

	const cdOffset = offset;
	const cdBuf = Buffer.concat(centralHeaders);
	const cdSize = cdBuf.length;

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdOffset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

await mkdir(fixturesDir, { recursive: true });

const samplePdf = buildMinimalPdf("PDF_FIXTURE_TEXT");
await writeFile(join(fixturesDir, "sample.pdf"), samplePdf);

const emptyPdf = buildMinimalPdf("");
await writeFile(join(fixturesDir, "empty.pdf"), emptyPdf);

const sampleDocx = buildMinimalDocx("DOCX_FIXTURE_TEXT");
await writeFile(join(fixturesDir, "sample.docx"), sampleDocx);

const emptyDocx = buildMinimalDocx("");
await writeFile(join(fixturesDir, "empty.docx"), emptyDocx);

console.log(`Generated fixtures in ${fixturesDir}:`);
console.log(`- sample.pdf: ${samplePdf.length} bytes`);
console.log(`- empty.pdf:  ${emptyPdf.length} bytes`);
console.log(`- sample.docx: ${sampleDocx.length} bytes`);
console.log(`- empty.docx:  ${emptyDocx.length} bytes`);

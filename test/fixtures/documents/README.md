# Document Extraction Test Fixtures

These minimal synthetic document fixtures are committed to test real extraction dependencies (`unpdf` and `mammoth`) and error boundaries in `sources.ts` (issue #87).

## Contents & Provenance

| Fixture | Size | Expected Extracted Text | Provenance & Purpose |
|---|---|---|---|
| `sample.pdf` | 591 B | `PDF_FIXTURE_TEXT` | Hand-crafted valid PDF 1.4 file with a single page, Helvetica Type 1 font, and exact cross-reference (`xref`) offsets. Contains zero personal or sensitive content. Exercises `unpdf` page extraction without triggering recovery warnings. |
| `empty.pdf` | 543 B | *(none)* | Valid PDF 1.4 with an empty page content stream (zero text operators). Exercises the empty document error path (*"No readable text found. Scanned PDFs need OCR, which Bro does not support."*). |
| `sample.docx` | 1,345 B | `DOCX_FIXTURE_TEXT` | Hand-crafted minimal OpenXML zip archive containing only `[Content_Types].xml`, `_rels/.rels`, and `word/document.xml`. Built with fixed DOS timestamps (`0x2121`). Exercises `mammoth` text extraction. |
| `empty.docx` | 1,328 B | *(none)* | Hand-crafted minimal OpenXML zip archive with an empty document body. Exercises `mammoth` text extraction on empty Word documents. |

All fixtures are 100% synthetic and licensed under the project's MIT license.

## Regeneration

All fixtures can be deterministically regenerated using:

```sh
node dev/generate-document-fixtures.mjs
```

This generator uses only the Node.js standard library (`node:zlib` for CRC32) with no third-party dependencies.

## Package Exclusion

These fixtures are test-only assets. They are excluded from published npm packages by the explicit `package.json#files` whitelist.

---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Installations can read scanned PDF pages with Amazon Textract by setting `document_extraction_ocr_enabled` to `true`, and it is off by default. With it on, a PDF page that has no text layer and paints an image is read by OCR, at most 12 pages per file, and its text starts with `--- Page N (OCR) ---`. A document's `input.summary` counts those pages, for example `PDF, 3 pages (2 read by OCR)` or `PDF, 40 pages (12 read by OCR, 28 without text)`. The `no_text` message now reads `the file has no readable text. If it is a scan, OCR found no text or isn't turned on.`, and `input_file_no_text` errors and `deployments chat --file` show it. A file that resolved before OCR was turned on keeps its result.

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

Reflect.set(globalThis, "pdfjsWorker", pdfjsWorker);

export async function pdfPages(bytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const document = await task.promise;
    const pages: { readonly width: number; readonly imageXObjectPaints: number }[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const operators = await page.getOperatorList();
      pages.push({
        width: page.view[2]! - page.view[0]!,
        imageXObjectPaints: operators.fnArray.filter(
          (operator) => operator === OPS.paintImageXObject,
        ).length,
      });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

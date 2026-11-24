const encoder = new TextEncoder();

export type FixturePage = readonly string[] | "vector-only" | { readonly scanWidth: number };

function escapePdfString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function serialize(objects: readonly string[], trailerExtra = "") {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(body).byteLength);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = encoder.encode(body).byteLength;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(body);
}

const stream = (dictionary: string, content: string) =>
  `<< ${dictionary}/Length ${encoder.encode(content).byteLength} >>\nstream\n${content}\nendstream`;

export function textPdf(pages: readonly FixturePage[], trailerExtra = "") {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const kids: number[] = [];
  for (const page of pages) {
    let width = 612;
    let xObjects = "";
    let content: string;
    if (page === "vector-only") {
      content = "0 0 0 rg 72 72 300 300 re f";
    } else if ("scanWidth" in page) {
      width = page.scanWidth;
      const image = objects.push(
        stream(
          "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode ",
          "00407F20>",
        ),
      );
      xObjects = ` /XObject << /Im1 ${image} 0 R >>`;
      content = "q 200 0 0 200 72 72 cm /Im1 Do Q";
    } else {
      content = `BT /F1 12 Tf 14 TL 72 720 Td ${page.map((line) => `(${escapePdfString(line)}) Tj T*`).join(" ")} ET`;
    }
    const contents = objects.push(stream("", content));
    kids.push(
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /Resources << /Font << /F1 3 0 R >>${xObjects} >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  return serialize(objects, trailerExtra);
}

export function passwordProtectedPdf() {
  const fill = "A".repeat(64);
  const pdf = textPdf([["secret"]]);
  const text = new TextDecoder().decode(pdf);
  const encryptObject = `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O <${fill}> /U <${fill}> >>`;
  const objects = [...text.matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj/gu)].map((match) => match[1]!);
  return serialize(
    [...objects, encryptObject],
    `/Encrypt ${objects.length + 1} 0 R /ID [<00112233445566778899AABBCCDDEEFF> <00112233445566778899AABBCCDDEEFF>] `,
  );
}

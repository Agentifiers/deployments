import type { PDFFont } from "pdf-lib";

export function printable(value: string) {
  return Array.from(value.normalize("NFKC"))
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function wordChunks(word: string, font: PDFFont, size: number, width: number) {
  const chunks: string[] = [];
  let current = "";
  for (const character of word) {
    const candidate = `${current}${character}`;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      chunks.push(current);
      current = character;
    } else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function wrappedLines(value: string, font: PDFFont, size: number, width: number) {
  const words = printable(value).split(" ").filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const chunks = wordChunks(word, font, size, width);
    chunks.forEach((chunk, index) => {
      const separator = current && index === 0 ? " " : "";
      const candidate = `${current}${separator}${chunk}`;
      if (current && font.widthOfTextAtSize(candidate, size) > width) {
        lines.push(current);
        current = chunk;
      } else current = candidate;
    });
  }
  if (current) lines.push(current);
  return lines;
}

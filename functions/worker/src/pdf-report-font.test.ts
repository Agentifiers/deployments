import { expect, test } from "bun:test";
import fontkit from "@pdf-lib/fontkit";
import { unicodeFontBytes } from "./pdf-report-font.ts";

test("embedded Unicode font covers advertised multilingual scripts", async () => {
  const font = fontkit.create(await unicodeFontBytes());
  const sample = "Résumé Ж 東京 مرحبا";
  expect(
    Array.from(sample)
      .filter((character) => character.trim())
      .every((character) => font.hasGlyphForCodePoint(character.codePointAt(0)!)),
  ).toBe(true);
  expect(font.characterSet.length).toBeGreaterThan(50_000);
});

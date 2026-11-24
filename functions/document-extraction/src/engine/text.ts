import type { DecodedText, Extractor } from "./extractor.ts";
import { untilTextBudget } from "./text-sink.ts";
import { UnusableFile } from "./unusable.ts";

const WINDOWS_1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];
const MAX_CONTROL_RATIO = 0.01;

function decodeWindows1252(bytes: Uint8Array) {
  let text = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    const codes = Array.from(bytes.subarray(offset, offset + 8_192), (byte) =>
      byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252_HIGH[byte - 0x80]! : byte,
    );
    text += String.fromCharCode(...codes);
  }
  return text;
}

function decodeUtf8(bytes: Uint8Array): DecodedText | undefined {
  try {
    return {
      encoding: "utf-8",
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch {
    return undefined;
  }
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): DecodedText {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = "";
  for (let offset = 0; offset + 1 < bytes.byteLength; offset += 16_384) {
    const units: number[] = [];
    for (let index = offset; index + 1 < Math.min(bytes.byteLength, offset + 16_384); index += 2) {
      units.push(view.getUint16(index, littleEndian));
    }
    text += String.fromCharCode(...units);
  }
  return { encoding: "utf-16", text };
}

function decodeByMark(bytes: Uint8Array): DecodedText | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes.subarray(2), true);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes.subarray(2), false);
  return decodeUtf8(bytes) ?? { encoding: "windows-1252", text: decodeWindows1252(bytes) };
}

export function decodeText(bytes: Uint8Array): DecodedText | undefined {
  const decoded = decodeByMark(bytes);
  if (decoded === undefined) return undefined;
  let controls = 0;
  for (let index = 0; index < decoded.text.length; index += 1) {
    const code = decoded.text.charCodeAt(index);
    if (code === 0) return undefined;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) {
      controls += 1;
    }
  }
  if (controls > decoded.text.length * MAX_CONTROL_RATIO) return undefined;
  return { encoding: decoded.encoding, text: decoded.text.replaceAll(/\r\n?/gu, "\n") };
}

export const extractText: Extractor<DecodedText> = async ({ encoding, text }, context) => {
  if (!/\S/u.test(text)) throw new UnusableFile("no_text", "the file is empty");
  await untilTextBudget(() => context.sink.write(text));
  const newlines = text.match(/\n/gu)?.length ?? 0;
  return { kind: "text", encoding, lines: text.endsWith("\n") ? newlines : newlines + 1 };
};

import { Buffer } from "node:buffer";
import {
  MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES,
  BrowserScreenshotCaptureError,
  type BrowserScreenshotContentType,
} from "./types.ts";

function uint32BigEndian(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function uint32LittleEndian(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] ?? 0) +
      ((bytes[offset + 1] ?? 0) << 8) +
      ((bytes[offset + 2] ?? 0) << 16) +
      (bytes[offset + 3] ?? 0) * 0x1000000) >>>
    0
  );
}

function pngCrc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isValidPng(bytes: Uint8Array) {
  if (
    bytes.length < 45 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  ) {
    return false;
  }

  let offset = 8;
  let sawHeader = false;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32BigEndian(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + length;
    const nextOffset = crcOffset + 4;
    if (nextOffset > bytes.length) return false;
    const type = Buffer.from(bytes.subarray(typeOffset, dataOffset)).toString("ascii");
    if (pngCrc32(bytes.subarray(typeOffset, crcOffset)) !== uint32BigEndian(bytes, crcOffset)) {
      return false;
    }
    if (!sawHeader) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        uint32BigEndian(bytes, dataOffset) === 0 ||
        uint32BigEndian(bytes, dataOffset + 4) === 0
      ) {
        return false;
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      return length === 0 && sawHeader && sawImageData && nextOffset === bytes.length;
    }
    offset = nextOffset;
  }
  return false;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function isValidJpeg(bytes: Uint8Array) {
  if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined || marker === 0x00) return false;
    offset += 1;
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const segmentLength = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (
        segmentLength < 8 ||
        (((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0)) === 0 ||
        (((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)) === 0
      ) {
        return false;
      }
      sawFrame = true;
    }
    if (marker !== 0xda) {
      offset += segmentLength;
      continue;
    }

    sawScan = true;
    offset += segmentLength;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const markerOffset = offset;
      while (bytes[offset] === 0xff) offset += 1;
      const scanMarker = bytes[offset];
      if (scanMarker === undefined) return false;
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = markerOffset;
      break;
    }
  }
  return false;
}

function isValidWebp(bytes: Uint8Array) {
  if (
    bytes.length < 20 ||
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "RIFF" ||
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") !== "WEBP" ||
    uint32LittleEndian(bytes, 4) !== bytes.length - 8
  ) {
    return false;
  }
  let offset = 12;
  let sawImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const type = Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii");
    const length = uint32LittleEndian(bytes, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const nextOffset = dataEnd + (length % 2);
    if (nextOffset > bytes.length) return false;
    if (type === "VP8X" && !isValidWebpExtendedHeader(bytes, dataOffset, length)) return false;
    if (type === "VP8 " || type === "VP8L") {
      if (!isValidWebpImageChunk(bytes, type, dataOffset, length)) return false;
      sawImageChunk = true;
    }
    if (type === "ANMF") {
      if (length < 16 || !hasValidWebpFrameImage(bytes, dataOffset + 16, dataEnd)) return false;
      sawImageChunk = true;
    }
    offset = nextOffset;
  }
  return sawImageChunk && offset === bytes.length;
}

function isValidWebpExtendedHeader(bytes: Uint8Array, offset: number, length: number) {
  if (length !== 10) return false;
  const flags = bytes[offset] ?? 0;
  return (
    (flags & 0xc1) === 0 &&
    bytes[offset + 1] === 0 &&
    bytes[offset + 2] === 0 &&
    bytes[offset + 3] === 0
  );
}

function isValidWebpImageChunk(
  bytes: Uint8Array,
  type: "VP8 " | "VP8L",
  offset: number,
  length: number,
) {
  if (type === "VP8L") {
    return length >= 5 && bytes[offset] === 0x2f && ((bytes[offset + 4] ?? 0) & 0xe0) === 0;
  }
  if (
    length < 10 ||
    ((bytes[offset] ?? 1) & 1) !== 0 ||
    bytes[offset + 3] !== 0x9d ||
    bytes[offset + 4] !== 0x01 ||
    bytes[offset + 5] !== 0x2a
  ) {
    return false;
  }
  const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
  const height = ((bytes[offset + 9] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
  return (width & 0x3fff) > 0 && (height & 0x3fff) > 0;
}

function hasValidWebpFrameImage(bytes: Uint8Array, start: number, end: number) {
  let offset = start;
  let sawImageChunk = false;
  while (offset + 8 <= end) {
    const type = Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii");
    const length = uint32LittleEndian(bytes, offset + 4);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + length + (length % 2);
    if (nextOffset > end) return false;
    if (type === "VP8 " || type === "VP8L") {
      if (!isValidWebpImageChunk(bytes, type, dataOffset, length)) return false;
      sawImageChunk = true;
    }
    offset = nextOffset;
  }
  return sawImageChunk && offset === end;
}

/** Rejects empty, oversized, or structurally invalid PNG, JPEG, and WebP screenshot bytes. */
export function assertBrowserScreenshotImage(
  bytes: Uint8Array,
  contentType: BrowserScreenshotContentType,
) {
  if (bytes.byteLength === 0) {
    throw new BrowserScreenshotCaptureError({ message: "Screenshot image is empty." });
  }
  if (bytes.byteLength > MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES) {
    throw new BrowserScreenshotCaptureError({
      message: "Screenshot image is larger than 25 MiB.",
    });
  }
  const valid =
    (contentType === "image/png" && isValidPng(bytes)) ||
    (contentType === "image/jpeg" && isValidJpeg(bytes)) ||
    (contentType === "image/webp" && isValidWebp(bytes));
  if (!valid) {
    throw new BrowserScreenshotCaptureError({
      message: `Screenshot image does not match ${contentType}.`,
    });
  }
}

import { encode } from "uqr";

/** One square per dark module, as a single path so the SVG stays small and crisp at any size. */
function modulePath(rows: readonly (readonly boolean[])[]) {
  return rows
    .flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])))
    .join("");
}

/**
 * The otpauth URI as a QR code an authenticator app can scan. The quiet zone stays light in both
 * themes because scanners need dark modules on a light ground.
 */
export function OtpauthQrCode({ uri }: Readonly<{ uri: string }>) {
  const { data, size } = encode(uri, { border: 4, ecc: "M" });
  return (
    <svg
      aria-label="QR code for your authenticator app"
      className="size-44 shrink-0 rounded-md bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <title>QR code for your authenticator app</title>
      <path d={modulePath(data)} fill="#000" />
    </svg>
  );
}

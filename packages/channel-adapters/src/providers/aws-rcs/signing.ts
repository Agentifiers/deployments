import { createHmac, timingSafeEqual } from "node:crypto";

function signature(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret).update(`v1:${timestamp}:${body}`).digest("hex");
}

export function signAwsRcsIngress(args: {
  readonly body: string;
  readonly secret: string;
  readonly timestamp: string;
}) {
  return `v1=${signature(args.secret, args.timestamp, args.body)}`;
}

export function verifyAwsRcsIngressSignature(args: {
  readonly body: string;
  readonly nowSeconds?: number;
  readonly secret: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
}) {
  const timestamp = Number(args.timestamp);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (Math.abs((args.nowSeconds ?? Math.floor(Date.now() / 1_000)) - timestamp) > 300) return false;
  const supplied = args.signature?.startsWith("v1=") ? args.signature.slice(3) : "";
  if (!/^[a-f0-9]{64}$/u.test(supplied)) return false;
  const expected = signature(args.secret, String(timestamp), args.body);
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

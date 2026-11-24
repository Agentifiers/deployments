import { sha256 } from "@deployments-ai/identity";
import { isIP } from "node:net";

export function sourcePrefixHash(event: {
  readonly requestContext?: { readonly identity?: { readonly sourceIp?: string } };
}) {
  const source = event.requestContext?.identity?.sourceIp?.split("%", 1)[0]?.trim();
  const family = source ? isIP(source) : 0;
  if (family === 4) return sha256(source!.split(".").slice(0, 3).join("."));
  if (family !== 6) return undefined;

  const [left = "", right = ""] = source!.split("::", 2);
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const missing = Math.max(0, 8 - leftGroups.length - rightGroups.length);
  const groups = [...leftGroups, ...Array<string>(missing).fill("0"), ...rightGroups].map(
    (group) => Number.parseInt(group || "0", 16) || 0,
  );
  const prefix = [groups[0], groups[1], groups[2], (groups[3] ?? 0) & 0xff00]
    .map((group) => group?.toString(16).padStart(4, "0"))
    .join(":");
  return sha256(prefix);
}

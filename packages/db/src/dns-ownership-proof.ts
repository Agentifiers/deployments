import { randomBytes } from "node:crypto";

export type ObserveTxt = (name: string) => Promise<readonly string[]>;

export interface DnsOwnershipProof {
  readonly name: string;
  readonly type: "TXT";
  readonly value: string;
}

export function dnsOwnershipProof(label: string, host: string, token: string): DnsOwnershipProof {
  return { name: `_${label}.${host}`, type: "TXT", value: `${label}=${token}` };
}

export function dnsOwnershipToken() {
  return randomBytes(16).toString("hex");
}

export async function dnsOwnershipProven(proof: DnsOwnershipProof, observeTxt: ObserveTxt) {
  return (await observeTxt(proof.name)).includes(proof.value);
}

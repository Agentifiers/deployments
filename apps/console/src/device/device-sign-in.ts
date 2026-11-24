import { PlatformApiError } from "../errors.ts";

/** The device page's query string as the router hands it over; nothing is trusted yet. */
export interface DeviceSearch {
  readonly code?: string;
}

/** What a successful claim tells the page: who asks, for what, and as whom. */
export interface DeviceRequest {
  readonly account: { readonly displayName?: string; readonly email?: string };
  /** The signed-in session already approved this code, as after a reload of the approved page. */
  readonly approved: boolean;
  readonly clientId: string;
  readonly clientName: string;
  readonly requestedScopes: readonly string[];
}

/** Why identity refused a code. Each reason needs different advice, so each is its own page. */
export type DeviceCodeRefusal = "expired" | "unknown" | "used";

/**
 * Where a device sign-in stands. `enter` asks for the code; `confirm` holds the claimed request
 * until the person approves or denies it; the rest are terminal for this code.
 */
export type DevicePhase =
  | { readonly kind: "enter" }
  | { readonly kind: "confirm"; readonly request: DeviceRequest }
  | { readonly kind: "approved"; readonly clientName: string }
  | { readonly kind: "denied"; readonly clientName: string }
  | { readonly kind: "refused"; readonly reason: DeviceCodeRefusal };

const REFUSAL_BY_CODE: Readonly<Record<string, DeviceCodeRefusal>> = {
  device_code_expired: "expired",
  device_code_unknown: "unknown",
  device_code_used: "used",
};

const CODE_LENGTH = 8;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u;

export function deviceSearch(raw: Readonly<Record<string, unknown>>): DeviceSearch {
  return typeof raw.code === "string" && raw.code ? { code: raw.code } : {};
}

/** The code a CLI from before the console page printed, in the `#code=` fragment. */
export function codeFromFragment(hash: string): string | undefined {
  const value = new URLSearchParams(hash.replace(/^#/u, "")).get("code");
  return value || undefined;
}

/** Uppercases, drops separators and spaces, and splits as the terminal shows it: `ABCD-EFGH`. */
export function formatUserCode(input: string): string {
  const characters = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .slice(0, CODE_LENGTH);
  return characters.length > 4 ? `${characters.slice(0, 4)}-${characters.slice(4)}` : characters;
}

export function isCompleteUserCode(code: string): boolean {
  return USER_CODE.test(code);
}

export function devicePath(code: string | undefined): string {
  return code ? `/device?${new URLSearchParams({ code })}` : "/device";
}

/** The phase a successful claim lands in. */
export function claimedPhase(request: DeviceRequest): DevicePhase {
  return request.approved
    ? { clientName: request.clientName, kind: "approved" }
    : { kind: "confirm", request };
}

/**
 * The phase a failed claim or decision lands in, or `undefined` when the failure says nothing
 * about the code (a network error, an unavailable service) and the page should offer a retry.
 */
export function refusedPhase(error: unknown): DevicePhase | undefined {
  const code = error instanceof PlatformApiError ? error.problem.code : undefined;
  const reason = code === undefined ? undefined : REFUSAL_BY_CODE[code];
  return reason === undefined ? undefined : { kind: "refused", reason };
}

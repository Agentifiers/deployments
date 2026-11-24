import type { Admission, Caller } from "./admission.ts";

type Exposure = "members" | "public";

type Unadmitted = Exclude<Admission, { readonly kind: "admitted" }>;

export type Access =
  | { readonly caller: Caller; readonly kind: "caller" }
  | { readonly admission: Unadmitted; readonly kind: "visitor" }
  | Unadmitted;

interface AccessRow {
  readonly anonymous: "anonymous" | "visitor";
  readonly refused: "refused" | "visitor";
}

const ACCESS_POLICY: Readonly<Record<Exposure, AccessRow>> = {
  members: { anonymous: "anonymous", refused: "refused" },
  public: { anonymous: "visitor", refused: "visitor" },
};

export function accessFor(exposure: Exposure, admission: Admission): Access {
  if (admission.kind === "admitted") return { caller: admission.caller, kind: "caller" };
  return ACCESS_POLICY[exposure][admission.kind] === "visitor"
    ? { admission, kind: "visitor" }
    : admission;
}

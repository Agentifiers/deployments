import type { BrainErasureResponse } from "@deployments-ai/api-contract/brains";

type BrainErasureReceipt = typeof BrainErasureResponse.Type;

/** `searchReceipt` is untyped, so it cannot cross a server function; the page needs only whether it exists. */
export interface BrainErasure extends Omit<BrainErasureReceipt, "searchReceipt"> {
  readonly searchAbsenceRecorded: boolean;
}

export function erasureView({ searchReceipt, ...receipt }: BrainErasureReceipt): BrainErasure {
  return { ...receipt, searchAbsenceRecorded: searchReceipt !== undefined };
}

export const ERASE_PHRASE = "erase";

export interface EraseSearch {
  readonly version?: number | undefined;
}

/**
 * The erase page's `?version=`: the archived Brain's version, which only the archive response
 * reports. The router spreads the result over the raw search, so an invalid version is set to
 * `undefined`, not omitted.
 */
export function parseEraseSearch(search: Readonly<Record<string, unknown>>): EraseSearch {
  const { version } = search;
  return {
    version:
      typeof version === "number" && Number.isSafeInteger(version) && version >= 0
        ? version
        : undefined,
  };
}

export type ErasurePhase =
  | { readonly kind: "queued" }
  | { readonly kind: "running"; readonly startedAt?: string }
  | {
      readonly completedAt?: string;
      readonly contentChecks: number;
      readonly kind: "erased";
      readonly recordsDeleted?: number;
      readonly searchAbsenceRecorded: boolean;
    }
  | { readonly error?: string; readonly kind: "failed" };

export function erasurePhase(erasure: BrainErasure): ErasurePhase {
  switch (erasure.status) {
    case "pending":
      return { kind: "queued" };
    case "running":
      return erasure.startedAt === undefined
        ? { kind: "running" }
        : { kind: "running", startedAt: erasure.startedAt };
    case "completed":
      return {
        ...(erasure.completedAt === undefined ? {} : { completedAt: erasure.completedAt }),
        contentChecks: erasure.contentVerificationCount,
        kind: "erased",
        ...(erasure.recordsDeleted === undefined ? {} : { recordsDeleted: erasure.recordsDeleted }),
        searchAbsenceRecorded: erasure.searchAbsenceRecorded,
      };
    case "failed":
      return erasure.error === undefined
        ? { kind: "failed" }
        : { error: erasure.error, kind: "failed" };
  }
}

export function erasureInFlight(erasure: BrainErasure | undefined): boolean {
  return erasure?.status === "pending" || erasure?.status === "running";
}

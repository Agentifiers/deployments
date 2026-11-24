import type { ThreadErasureOperationResponse } from "@deployments-ai/api-contract/governance";

/** The runtime erasure resource shares these fields with its governance operation. */
type ConversationErasure = Pick<
  typeof ThreadErasureOperationResponse.Type,
  "counts" | "phase" | "status"
>;
type Phase = ConversationErasure["phase"];
type Counts = ConversationErasure["counts"];

/** The words a user types to confirm erasing a thread or an end user's conversations. */
export const ERASE_THREAD_PHRASE = "erase thread";
export const ERASE_END_USER_PHRASE = "erase end user";

/** Terminal statuses stop polling; the rest keep the status view refreshing. */
export function erasureSettled(erasure: Pick<ConversationErasure, "status">): boolean {
  return (
    erasure.status === "completed" || erasure.status === "failed" || erasure.status === "canceled"
  );
}

/** Each erasure phase in the order the platform runs them, as a customer would name it. */
export const ERASURE_PHASES: readonly { readonly label: string; readonly phase: Phase }[] = [
  { label: "Finding conversations", phase: "planning" },
  { label: "Email", phase: "mail" },
  { label: "Stopping new activity", phase: "fencing" },
  { label: "Automations", phase: "automations" },
  { label: "Memory", phase: "memory" },
  { label: "Threads, runs, and messages", phase: "canonical" },
  { label: "Inbound records", phase: "ingress" },
  { label: "Live streams", phase: "streams" },
  { label: "Files", phase: "objects" },
  { label: "Traces and metrics", phase: "observability" },
  { label: "Finishing", phase: "finalizing" },
];

/** Counts shown on the status view, in display order; the rest are internal bookkeeping. */
export const ERASURE_COUNTS: readonly { readonly key: keyof Counts; readonly label: string }[] = [
  { key: "threadsErased", label: "Threads erased" },
  { key: "runsCanceled", label: "Runs canceled" },
  { key: "recordsDeleted", label: "Records deleted" },
  { key: "memoriesErased", label: "Memories erased" },
  { key: "emailThreadsErased", label: "Email threads erased" },
  { key: "emailMessagesErased", label: "Email messages erased" },
  { key: "automationsArchived", label: "Automations archived" },
  { key: "streamsDeleted", label: "Streams deleted" },
  { key: "objectsStaged", label: "Files deleted" },
];

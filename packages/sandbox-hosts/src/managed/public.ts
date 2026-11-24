import type { SandboxLeaseRecordValue, ManagedSandbox } from "./contracts.ts";
import { leaseFromRecord } from "./leases.ts";

export function managedSandboxFromRecord(record: SandboxLeaseRecordValue): ManagedSandbox {
  return { lease: leaseFromRecord(record), record };
}

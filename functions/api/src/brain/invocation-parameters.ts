import { failure } from "../persistence-failure.ts";
import type { BrainApiInvocation } from "./service-contracts.ts";

export function requiredParam(invocation: BrainApiInvocation, name: string) {
  return (
    invocation.params[name] ??
    failure("invalid-input", "missing_path_parameter", `${name} is required.`)
  );
}

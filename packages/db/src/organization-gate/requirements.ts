import type { TransactionConditionCheck } from "../client-types.ts";
import { key } from "../keys.ts";

/** Organization-wide state a tenant transaction requires, beyond existing and not being fenced. */
export type OrganizationGateRequirement =
  | { readonly kind: "organization-active" }
  | {
      readonly kind: "memory-search-placement";
      readonly generation: number;
      readonly version: number;
    }
  | {
      readonly kind: "memory-search-mutation-fence-open";
      readonly epoch: number;
      readonly version: number;
    }
  | { readonly kind: "memory-provider-gate-open"; readonly targetId: string }
  | {
      readonly kind: "brain-search-placement-active";
      readonly generation: number;
      readonly version: number;
    };

export interface OrganizationGateCondition {
  readonly organizationId: string;
  readonly requirement: OrganizationGateRequirement;
}

interface ConditionParts {
  readonly conditionExpression: string;
  readonly expressionAttributeNames: Readonly<Record<string, string>>;
  readonly expressionAttributeValues: Readonly<Record<string, unknown>>;
}

function sourceCheck(organizationId: string, requirement: OrganizationGateRequirement) {
  const organizationPartition = key("ORG", organizationId);
  switch (requirement.kind) {
    case "organization-active":
      return {
        conditionExpression: "#itemType = :itemType AND #data.#status = :active",
        expressionAttributeNames: { "#data": "data", "#itemType": "itemType", "#status": "status" },
        expressionAttributeValues: { ":active": "active", ":itemType": "organization" },
        key: { pk: organizationPartition, sk: key("ORG", organizationId) },
      };
    case "memory-search-placement":
      return {
        conditionExpression:
          "#data.#version = :version AND #data.#generation = :generation AND #itemType = :itemType",
        expressionAttributeNames: {
          "#data": "data",
          "#generation": "generation",
          "#itemType": "itemType",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":generation": requirement.generation,
          ":itemType": "memory-search-placement",
          ":version": requirement.version,
        },
        key: { pk: organizationPartition, sk: key("MEMORY-SEARCH-PLACEMENT", organizationId) },
      };
    case "memory-search-mutation-fence-open":
      return {
        conditionExpression:
          "#data.#version = :version AND #data.#epoch = :epoch AND #data.#status = :open AND #itemType = :itemType",
        expressionAttributeNames: {
          "#data": "data",
          "#epoch": "epoch",
          "#itemType": "itemType",
          "#status": "status",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":epoch": requirement.epoch,
          ":itemType": "memory-search-mutation-fence",
          ":open": "open",
          ":version": requirement.version,
        },
        key: { pk: organizationPartition, sk: key("MEMORY-SEARCH-MUTATION-FENCE", organizationId) },
      };
    case "memory-provider-gate-open":
      return {
        conditionExpression: "#data.#status = :open AND #itemType = :itemType",
        expressionAttributeNames: { "#data": "data", "#itemType": "itemType", "#status": "status" },
        expressionAttributeValues: {
          ":itemType": "memory-provider-mutation-gate",
          ":open": "open",
        },
        key: {
          pk: organizationPartition,
          sk: key("MEMORY-PROVIDER-MUTATION-GATE", requirement.targetId),
        },
      };
    case "brain-search-placement-active":
      return {
        conditionExpression:
          "#itemType = :itemType AND #data.#version = :version AND #data.#phase = :phase AND #data.#generation = :generation",
        expressionAttributeNames: {
          "#data": "data",
          "#generation": "generation",
          "#itemType": "itemType",
          "#phase": "phase",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":generation": requirement.generation,
          ":itemType": "brain-search-placement",
          ":phase": "active",
          ":version": requirement.version,
        },
        key: { pk: organizationPartition, sk: key("BRAIN-SEARCH-PLACEMENT", organizationId) },
      };
  }
}

/**
 * A condition check on the organization-wide record that holds `requirement`. A transaction that
 * does not change that state checks the requirement on one of the organization's gate lanes
 * instead, so concurrent writes in one organization do not share the record.
 */
export function organizationGateCheck(
  organizationId: string,
  requirement: OrganizationGateRequirement,
): TransactionConditionCheck {
  return {
    ...sourceCheck(organizationId, requirement),
    kind: "condition-check",
    organizationGate: { organizationId, requirement },
    table: "control",
  };
}

/** The same requirement as a term on a gate lane. `index` keeps placeholders unique per term. */
export function laneRequirementTerm(
  requirement: OrganizationGateRequirement,
  index: number,
): ConditionParts {
  const value = (name: string) => `:gate${index}${name}`;
  switch (requirement.kind) {
    case "organization-active":
      return {
        conditionExpression: `#gate.#gateOrganization.#gateStatus = ${value("Active")}`,
        expressionAttributeNames: { "#gateOrganization": "organization", "#gateStatus": "status" },
        expressionAttributeValues: { [value("Active")]: "active" },
      };
    case "memory-search-placement":
      return {
        conditionExpression: `#gate.#gateMemoryPlacement.#gateVersion = ${value("Version")} AND #gate.#gateMemoryPlacement.#gateGeneration = ${value("Generation")}`,
        expressionAttributeNames: {
          "#gateGeneration": "generation",
          "#gateMemoryPlacement": "memorySearchPlacement",
          "#gateVersion": "version",
        },
        expressionAttributeValues: {
          [value("Generation")]: requirement.generation,
          [value("Version")]: requirement.version,
        },
      };
    case "memory-search-mutation-fence-open":
      return {
        conditionExpression: `#gate.#gateMutationFence.#gateVersion = ${value("Version")} AND #gate.#gateMutationFence.#gateEpoch = ${value("Epoch")} AND #gate.#gateMutationFence.#gateStatus = ${value("Open")}`,
        expressionAttributeNames: {
          "#gateEpoch": "epoch",
          "#gateMutationFence": "memorySearchMutationFence",
          "#gateStatus": "status",
          "#gateVersion": "version",
        },
        expressionAttributeValues: {
          [value("Epoch")]: requirement.epoch,
          [value("Open")]: "open",
          [value("Version")]: requirement.version,
        },
      };
    case "memory-provider-gate-open":
      return {
        conditionExpression: `#gate.#gateProviderGates.#gateTarget${index} = ${value("Open")}`,
        expressionAttributeNames: {
          "#gateProviderGates": "memoryProviderGates",
          [`#gateTarget${index}`]: requirement.targetId,
        },
        expressionAttributeValues: { [value("Open")]: "open" },
      };
    case "brain-search-placement-active":
      return {
        conditionExpression: `#gate.#gateBrainPlacement.#gateVersion = ${value("Version")} AND #gate.#gateBrainPlacement.#gateGeneration = ${value("Generation")} AND #gate.#gateBrainPlacement.#gatePhase = ${value("Active")}`,
        expressionAttributeNames: {
          "#gateBrainPlacement": "brainSearchPlacement",
          "#gateGeneration": "generation",
          "#gatePhase": "phase",
          "#gateVersion": "version",
        },
        expressionAttributeValues: {
          [value("Active")]: "active",
          [value("Generation")]: requirement.generation,
          [value("Version")]: requirement.version,
        },
      };
  }
}

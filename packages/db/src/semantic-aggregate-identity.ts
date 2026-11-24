import type { PlatformRecord } from "./records/index.ts";

export interface SemanticAggregate {
  readonly aggregateId: string;
  readonly aggregateType: string;
}

/**
 * The semantic-event aggregates whose state this stored record holds. Most records are the
 * aggregate named by their item type and `data.id`; the cases below name theirs differently.
 */
export function semanticAggregatesOf(record: PlatformRecord): readonly SemanticAggregate[] {
  switch (record.itemType) {
    case "brain-search-placement":
      return [{ aggregateId: record.data.organizationId, aggregateType: record.itemType }];
    case "email-domain":
      return [{ aggregateId: record.data.id, aggregateType: "email_domain" }];
    case "email-tenant":
      return [{ aggregateId: record.data.id, aggregateType: "email_tenant" }];
    case "evaluation-run":
      return [{ aggregateId: record.data.id, aggregateType: "evaluation_run" }];
    case "governance-operation":
      return [{ aggregateId: record.data.id, aggregateType: record.data.kind }];
    case "memory-search-provisioning":
      return [{ aggregateId: record.data.id, aggregateType: "memory-search-operation" }];
    case "model-provider-credential":
      return [{ aggregateId: record.data.credentialId, aggregateType: record.itemType }];
    case "organization-egress-allowlist":
    case "organization-identity-provider":
      return [{ aggregateId: record.data.organizationId, aggregateType: record.itemType }];
    case "organization-member":
    case "organization-operator-access":
      return [{ aggregateId: record.data.principalId, aggregateType: record.itemType }];
    case "organization-standing":
      return [
        { aggregateId: record.data.organizationId, aggregateType: record.itemType },
        ...(record.data.suspension
          ? [{ aggregateId: record.data.suspension.id, aggregateType: "organization-suspension" }]
          : []),
      ];
    case "regression-dataset":
      return [{ aggregateId: record.data.id, aggregateType: "regression_dataset" }];
    case "release-comparison":
      return [{ aggregateId: record.data.id, aggregateType: "release_comparison" }];
    case "score-definition":
      return [{ aggregateId: record.data.id, aggregateType: "score_definition" }];
    default: {
      const id = (record.data as Readonly<Record<string, unknown>>).id;
      return typeof id === "string" ? [{ aggregateId: id, aggregateType: record.itemType }] : [];
    }
  }
}

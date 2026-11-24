import { Ulid, type OrganizationHoldReader } from "@deployments-ai/db";
import {
  admitConsistently,
  organizationRefusalResult,
  type ApiActivity,
} from "@deployments-ai/organization-admission";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";

/**
 * The `403 organization_suspended` answer when the organization's holds refuse `activity`, or
 * `undefined` when they allow it. Standing is read strongly consistently and a failed read throws,
 * so the request fails closed.
 */
export async function standingRefusal(input: {
  readonly activity: ApiActivity;
  readonly organizationId: string;
  readonly requestId: string | undefined;
  readonly standing: OrganizationHoldReader;
}) {
  const { decision } = await admitConsistently({
    activity: input.activity,
    organizationId: Schema.decodeUnknownSync(Ulid)(input.organizationId),
    standing: input.standing,
  });
  return decision.kind === "admitted"
    ? undefined
    : organizationRefusalResult(decision, input.requestId ?? randomUUID());
}

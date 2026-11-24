import { createHash } from "node:crypto";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { makeIdentitySecurityEventRecord } from "../identity/security-events.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { linkAnchor } from "./claims.ts";
import { normalizedEmailDomain } from "./linking.ts";
import {
  createWithClaims,
  deleteWithClaims,
  endPrincipalSessions,
  versionPin,
} from "./operations.ts";
import { makeFederationReads } from "./reads.ts";
import { federationRecord, nextFederationRecord } from "./record-builders.ts";

const LINK_WRITE_ATTEMPTS = 5;

export type LinkConfirmationOutcome =
  | { readonly kind: "linked"; readonly organizationId: Ulid }
  | { readonly kind: "browser-mismatch" }
  | { readonly kind: "invalid" };

export interface LinkConfirmationInput {
  readonly bindingHash: string | undefined;
  readonly token: string;
}

export interface PendingFederationLink {
  readonly expiresAt: string;
  readonly identityProvider: { readonly displayName: string; readonly issuer: string };
  readonly organizationName: string;
  readonly principalId: Ulid;
}

type LinkPlan =
  | Exclude<LinkConfirmationOutcome, { readonly kind: "linked" }>
  | {
      readonly kind: "write";
      readonly operations: readonly TransactionOperation[];
      readonly organizationId: Ulid;
    };

const linkTokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export async function pendingFederationLink(
  database: DynamoDatabaseService,
  token: string,
  now: Date,
): Promise<PendingFederationLink | undefined> {
  const reads = makeFederationReads(database);
  const request = await reads.linkRequest(linkTokenHash(token));
  if (request?.data.status !== "pending" || Date.parse(request.data.expiresAt) <= now.getTime()) {
    return undefined;
  }
  const [provider, organization] = await Promise.all([
    reads.provider(request.data.organizationId),
    reads.organization(request.data.organizationId),
  ]);
  if (
    provider?.data.state.kind !== "active" ||
    provider.data.connectionId !== request.data.connectionId ||
    !organization
  ) {
    return undefined;
  }
  return {
    expiresAt: request.data.expiresAt,
    identityProvider: { displayName: provider.data.displayName, issuer: request.data.issuer },
    organizationName: organization.data.name,
    principalId: request.data.principalId,
  };
}

export function makeLinkConfirmation(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Ulid;
  readonly now: () => Date;
}): (input: LinkConfirmationInput) => Promise<LinkConfirmationOutcome> {
  const reads = makeFederationReads(dependencies.database);

  async function plan(input: LinkConfirmationInput): Promise<LinkPlan> {
    const request = await reads.linkRequest(linkTokenHash(input.token));
    const at = dependencies.now();
    if (request?.data.status !== "pending" || Date.parse(request.data.expiresAt) <= at.getTime()) {
      return { kind: "invalid" };
    }
    if (input.bindingHash !== request.data.bindingHash) return { kind: "browser-mismatch" };
    const { connectionId, organizationId, principalId, subject } = request.data;
    const updatedAt = at.toISOString();
    const consumed = nextFederationRecord(request, { status: "consumed" }, updatedAt);
    const consume: TransactionOperation = {
      kind: "put",
      previousRecord: request,
      record: consumed,
    };
    const [provider, principal] = await Promise.all([
      reads.provider(organizationId),
      reads.principal(principalId),
    ]);
    if (provider?.data.state.kind !== "active" || provider.data.connectionId !== connectionId) {
      return { kind: "invalid" };
    }
    const anchor = linkAnchor(provider.data);
    const existing = await reads.link(anchor, subject);
    if (existing) {
      return existing.data.principalId === principalId
        ? { kind: "write", operations: [consume], organizationId }
        : { kind: "invalid" };
    }
    const email = principal?.data.primaryEmail;
    const domain = normalizedEmailDomain(email);
    const loginDomain = domain ? await reads.loginDomain(organizationId, domain) : undefined;
    if (
      principal?.data.kind !== "human" ||
      principal.data.status !== "active" ||
      principal.data.platformRole !== undefined ||
      loginDomain?.data.state.kind !== "verified"
    ) {
      return { kind: "invalid" };
    }
    const [previousLink, security, fence] = await Promise.all([
      reads.organizationLink(organizationId, principalId),
      reads.securityState(principalId),
      reads.bffFence(principalId),
    ]);
    if (!security || !fence) return { kind: "invalid" };
    const link = federationRecord("principal-identity", {
      ...anchor,
      createdAt: updatedAt,
      ...(email ? { email } : {}),
      id: dependencies.generateId(),
      organizationId,
      principalId,
      subject,
      updatedAt,
      version: 1,
    });
    return {
      kind: "write",
      organizationId,
      operations: [
        versionPin(provider),
        versionPin(loginDomain),
        versionPin(principal),
        consume,
        ...(previousLink ? deleteWithClaims(previousLink) : []),
        ...createWithClaims(link, updatedAt),
        {
          kind: "put",
          record: makeIdentitySecurityEventRecord({
            aggregateId: link.data.id,
            aggregateType: "principal-identity",
            aggregateVersion: 1,
            eventId: dependencies.generateId(),
            eventType: "identity.federated-identity-linked",
            occurredAt: updatedAt,
            principalId,
          }),
        },
        ...endPrincipalSessions({
          at: updatedAt,
          eventId: dependencies.generateId(),
          fence,
          security,
        }),
      ],
    };
  }

  return async (input) => {
    for (let attempt = 0; attempt < LINK_WRITE_ATTEMPTS; attempt += 1) {
      const next = await plan(input);
      if (next.kind !== "write") return next;
      try {
        await dependencies.database.transactWrite(next.operations);
        return { kind: "linked", organizationId: next.organizationId };
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
      }
    }
    return { kind: "invalid" };
  };
}

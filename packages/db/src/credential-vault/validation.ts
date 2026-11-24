import { createHash } from "node:crypto";

import {
  CredentialVaultError,
  type CredentialVaultIdentity,
  type CredentialVaultSecretInput,
} from "./types.ts";

const FIELD_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/u;

function requiredText(value: string, label: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized) throw new CredentialVaultError("invalid-input", `${label} is required.`);
  if (normalized.length > maximum) {
    throw new CredentialVaultError("invalid-input", `${label} is too long.`);
  }
  return normalized;
}

function canonicalTimestamp(value: string, label: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new CredentialVaultError("invalid-input", `${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

export function normalizeCredentialVaultIdentity(identity: CredentialVaultIdentity) {
  return {
    ...identity,
    purpose: requiredText(identity.purpose, "Credential purpose", 120),
  };
}

export function normalizeCredentialVaultSecret(input: CredentialVaultSecretInput) {
  const values: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input.values)) {
    const name = requiredText(rawName, "Credential field name", 80);
    if (!FIELD_PATTERN.test(name)) {
      throw new CredentialVaultError("invalid-input", `Invalid credential field name: ${name}.`);
    }
    if (typeof rawValue !== "string" || rawValue.length === 0) {
      throw new CredentialVaultError("invalid-input", `Credential field ${name} is required.`);
    }
    values[name] = rawValue;
  }
  if (Object.keys(values).length === 0) {
    throw new CredentialVaultError("invalid-input", "At least one credential field is required.");
  }

  const metadata = Object.fromEntries(
    Object.entries(input.metadata ?? {}).map(([name, value]) => [
      requiredText(name, "Credential metadata name", 80),
      requiredText(value, `Credential metadata ${name}`, 512),
    ]),
  );
  const scopes = [
    ...new Set((input.scopes ?? []).map((scope) => scope.trim()).filter(Boolean)),
  ].toSorted((left, right) => left.localeCompare(right));
  return {
    ...(input.expiresAt ? { expiresAt: canonicalTimestamp(input.expiresAt, "expiresAt") } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    values,
  };
}

export function credentialVaultEncryptionContext(identity: CredentialVaultIdentity) {
  return Object.freeze({
    environmentId: identity.environmentId,
    organizationId: identity.organizationId,
    ownerId: identity.ownerId,
    ownerType: identity.ownerType,
    projectId: identity.projectId,
    purpose: identity.purpose,
    credentialId: identity.credentialId,
  });
}

export function credentialVaultEncryptionContextHash(context: Readonly<Record<string, string>>) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(context).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}

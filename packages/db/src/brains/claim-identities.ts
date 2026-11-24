export function normalizeBrainExternalItemIdentity(externalItemIdentity: string) {
  const normalized = externalItemIdentity.trim();
  if (!normalized) throw new TypeError("Brain external item identity is required.");
  return normalized;
}

export function brainSourceRevisionClaimNamespace(
  organizationId: string,
  sourceId: string,
  externalItemIdentity: string,
) {
  return `organization:${organizationId}:brain-source:${sourceId}:item:${normalizeBrainExternalItemIdentity(externalItemIdentity)}:revision`;
}

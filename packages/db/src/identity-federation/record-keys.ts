import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { requiredField, type KeyableRecord } from "../record-key-fields.ts";
import {
  IDENTITY_PROVIDER_SLOT,
  type FEDERATION_IDENTITY_RECORD_SCHEMAS,
} from "../records/identity-federation.ts";

type HashKeyedItemType = keyof typeof FEDERATION_IDENTITY_RECORD_SCHEMAS;

const HASH_KEYED_PREFIXES: {
  readonly [ItemType in HashKeyedItemType]: readonly [
    label: string,
    field: keyof (typeof FEDERATION_IDENTITY_RECORD_SCHEMAS)[ItemType]["Type"]["data"] & string,
  ];
} = {
  "identity-federation-link-request": ["IDENTITY-FEDERATION-LINK-REQUEST", "tokenHash"],
  "identity-federation-transaction": ["IDENTITY-FEDERATION-TRANSACTION", "lookupHash"],
  "identity-federation-unsolicited-sign-in": [
    "IDENTITY-FEDERATION-UNSOLICITED-SIGN-IN",
    "tokenHash",
  ],
};

export function identityFederationPrimaryKeys(record: KeyableRecord) {
  const prefixes: Readonly<Partial<Record<string, readonly [string, string]>>> =
    HASH_KEYED_PREFIXES;
  const prefix = prefixes[record.itemType];
  if (!prefix) return undefined;
  const [label, field] = prefix;
  const partition = key(label, requiredField(record, field));
  return { pk: partition, sk: partition };
}

export function identityProviderKey(organizationId: Ulid) {
  return {
    pk: key("ORG", organizationId),
    sk: key("ORGANIZATION-IDENTITY-PROVIDER", IDENTITY_PROVIDER_SLOT),
  };
}

export function passwordCredentialKey(principalId: Ulid) {
  return { pk: key("PRINCIPAL", principalId), sk: key("PRINCIPAL-CREDENTIAL", "password") };
}

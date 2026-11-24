/**
 * Credential-vault purpose of a hosted code tool's write-only secret values. The vault entry is
 * owned by the tool adapter; the worker injects only release-pinned names as environment
 * variables for a single execution.
 */
export const HOSTED_CODE_SECRETS_VAULT_PURPOSE = "hosted-code-secrets";

import { deviceAuthorizedPlatformToken } from "../../packages/e2e/src/harness/identity-device-token.ts";
import type { IdentityLogin } from "./cli.ts";
import { storedPassword } from "./password-source.ts";
import type { SecretStore } from "./secrets.ts";

/** Signs in as the identity and approves a device authorization for a platform bearer token. */
export async function mintPlatformToken(input: {
  readonly apiUrl: string;
  readonly login: IdentityLogin;
  readonly secrets: () => SecretStore;
}) {
  const { login } = input;
  const password =
    login.password.kind === "environment"
      ? login.password.password
      : storedPassword({
          secret: await input.secrets().read(login.password.secretId),
          secretId: login.password.secretId,
        });
  return await deviceAuthorizedPlatformToken(input.apiUrl, {
    issuer: login.issuer,
    password,
    username: login.username,
  });
}

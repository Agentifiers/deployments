import { SSMClient } from "@aws-sdk/client-ssm";
import { ensureApiKey } from "./platform-credential/api-key-command.ts";
import { type CliCommand, parseCli, usage } from "./platform-credential/cli.ts";
import { ensureOperatorIdentity } from "./platform-credential/identity-command.ts";
import { httpPlatformApi } from "./platform-credential/platform-api.ts";
import { awsSecretStore, type SecretStore } from "./platform-credential/secrets.ts";
import { mintPlatformToken } from "./platform-credential/token-command.ts";
import { runMain } from "./platform-deploy/process.ts";

async function execute(command: Exclude<CliCommand, { readonly kind: "help" }>) {
  let client: SSMClient | undefined;
  let store: SecretStore | undefined;
  // Only commands that name a parameter construct a Parameter Store client.
  const secrets = () => {
    client ??= new SSMClient({});
    store ??= awsSecretStore(client);
    return store;
  };
  try {
    switch (command.kind) {
      case "identity": {
        const result = await ensureOperatorIdentity(command, secrets);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      case "token": {
        const issued = await mintPlatformToken({ ...command, secrets });
        process.stdout.write(
          command.format === "json"
            ? `${JSON.stringify({ expiresAt: new Date(issued.expiresAtMs).toISOString(), token: issued.token })}\n`
            : `${issued.token}\n`,
        );
        return;
      }
      case "api-key": {
        const bearer =
          command.bearer.kind === "api-key"
            ? command.bearer.key
            : (
                await mintPlatformToken({
                  apiUrl: command.apiUrl,
                  login: command.bearer.login,
                  secrets,
                })
              ).token;
        const result = await ensureApiKey({
          api: httpPlatformApi({ apiUrl: command.apiUrl, bearer, tenancy: command.tenancy }),
          environmentId: command.tenancy.environmentId,
          name: command.name,
          rotate: command.rotate,
          scopes: command.scopes,
          secretId: command.secretId,
          secrets: secrets(),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
    }
  } finally {
    client?.destroy();
  }
}

async function main() {
  const command = parseCli(process.argv.slice(2), process.env);
  if (command.kind === "help") {
    process.stdout.write(`${usage(command.command)}\n`);
    return;
  }
  await execute(command);
}

if (import.meta.main) runMain(main);

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CliError, ExitCode } from "./errors.ts";
import { optional } from "./profile-resolution-helpers.ts";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  let deploymentsRoot: string | undefined;
  if (env.DEPLOYMENTS_CONFIG_DIR !== undefined) {
    deploymentsRoot = optional(env.DEPLOYMENTS_CONFIG_DIR);
    if (!deploymentsRoot || !isAbsolute(deploymentsRoot)) {
      throw new CliError(
        "DEPLOYMENTS_CONFIG_DIR must be a non-empty, unpadded absolute path.",
        ExitCode.validation,
      );
    }
  }
  const xdgRoot = optional(env.XDG_CONFIG_HOME);
  const root =
    deploymentsRoot ?? (xdgRoot && isAbsolute(xdgRoot) ? xdgRoot : join(homedir(), ".config"));
  return join(root, "deployments", "config.json");
}

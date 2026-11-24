import type { ObserveTxt } from "@deployments-ai/db";

/** The `node:dns/promises` `resolveTxt` shape: each record is a list of character strings. */
export type ResolveTxt = (name: string) => Promise<string[][]>;

export function txtObserver(resolveTxt: ResolveTxt, lookupFailed: () => Error): ObserveTxt {
  return async (name) => {
    try {
      return (await resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENODATA" || cause.code === "ENOTFOUND")
      ) {
        return [];
      }
      throw lookupFailed();
    }
  };
}

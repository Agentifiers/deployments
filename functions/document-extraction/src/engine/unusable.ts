import type { InputFileUnusableReason } from "@deployments-ai/agent-manifest/input-files";

export class UnusableFile extends Error {
  override readonly name = "UnusableFile";

  constructor(
    readonly reason: InputFileUnusableReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

export class EntryTooLarge extends UnusableFile {
  constructor(maxBytes: number) {
    super("limits_exceeded", `an entry inflates past ${maxBytes} bytes`);
  }
}

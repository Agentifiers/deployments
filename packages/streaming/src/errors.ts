export class StreamContractError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "StreamContractError";
  }
}

export class StreamSessionExpiredError extends Error {
  constructor(readonly expiresAt: string) {
    super(`Thread stream session expired at ${expiresAt}.`);
    this.name = "StreamSessionExpiredError";
  }
}

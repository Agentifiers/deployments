export class MemoryCheckpointSizeError extends TypeError {
  constructor(
    readonly byteLength: number,
    readonly maximumBytes: number,
  ) {
    super(`Memory flush checkpoint must not exceed ${maximumBytes} UTF-8 bytes.`);
    this.name = "MemoryCheckpointSizeError";
  }
}

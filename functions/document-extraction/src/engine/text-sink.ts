const encoder = new TextEncoder();
const INITIAL_BYTES = 64 * 1024;

export class TextBudgetReached extends Error {
  override readonly name = "TextBudgetReached";
}

export class TextSink {
  #buffer: Uint8Array;
  #length = 0;
  #truncated = false;

  constructor(readonly capacity: number) {
    this.#buffer = new Uint8Array(Math.min(capacity, INITIAL_BYTES));
  }

  get truncated() {
    return this.#truncated;
  }

  get byteLength() {
    return this.#length;
  }

  markTruncated() {
    this.#truncated = true;
  }

  stop(): never {
    this.#truncated = true;
    throw new TextBudgetReached();
  }

  write(text: string): void {
    if (this.#truncated) throw new TextBudgetReached();
    let pending = text;
    for (;;) {
      const { read, written } = encoder.encodeInto(pending, this.#buffer.subarray(this.#length));
      this.#length += written;
      if (read === pending.length) return;
      pending = pending.slice(read);
      if (this.#buffer.byteLength === this.capacity) this.stop();
      const grown = new Uint8Array(
        Math.min(
          this.capacity,
          Math.max(this.#buffer.byteLength * 2, this.#length + pending.length * 3),
        ),
      );
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
  }

  bytes(): Uint8Array {
    return this.#buffer.subarray(0, this.#length);
  }
}

export async function untilTextBudget(read: () => Promise<void> | void): Promise<void> {
  try {
    await read();
  } catch (error) {
    if (!(error instanceof TextBudgetReached)) throw error;
  }
}

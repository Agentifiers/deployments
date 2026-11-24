export type ObjectBody =
  | { readonly bytes: Uint8Array; readonly kind: "bytes" }
  | { readonly kind: "file"; readonly path: string; readonly sizeBytes: number };

export interface PutObjectInput {
  readonly body: ObjectBody;
  readonly key: string;
  readonly sha256: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type PutObjectOutcome = "created" | "exists";

export interface StoredObject {
  readonly sha256: string | undefined;
  readonly sizeBytes: number;
}

export interface RegistryStore {
  putObject(input: PutObjectInput): Promise<PutObjectOutcome>;
  getObject(key: string): Promise<ReadableStream<Uint8Array> | undefined>;
  headObject(key: string): Promise<StoredObject | undefined>;
  listChildNames(prefix: string): Promise<readonly string[]>;
  getObjectTags(key: string): Promise<Readonly<Record<string, string>>>;
  putObjectTags(key: string, tags: Readonly<Record<string, string>>): Promise<void>;
}

export async function readObjectBytes(store: RegistryStore, key: string) {
  const stream = await store.getObject(key);
  return stream ? await new Response(stream).bytes() : undefined;
}

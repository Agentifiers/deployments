import { createHash } from "node:crypto";
import type { RegistryStore } from "./store.ts";

interface MemoryObject {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  tags: Readonly<Record<string, string>>;
}

export interface MemoryRegistryStore extends RegistryStore {
  expire(key: string): void;
  runLifecycle(): void;
}

export function memoryRegistryStore(): MemoryRegistryStore {
  const objects = new Map<string, MemoryObject>();
  const stored = (key: string) => {
    const object = objects.get(key);
    if (!object) throw new Error(`NoSuchKey: ${key}`);
    return object;
  };
  return {
    expire(key) {
      objects.delete(key);
    },
    async getObject(key) {
      const object = objects.get(key);
      return object ? new Blob([object.bytes]).stream() : undefined;
    },
    async getObjectTags(key) {
      return stored(key).tags;
    },
    async headObject(key) {
      const object = objects.get(key);
      return object ? { sha256: object.sha256, sizeBytes: object.bytes.byteLength } : undefined;
    },
    async listChildNames(prefix) {
      const children = new Set<string>();
      for (const key of objects.keys()) {
        if (!key.startsWith(prefix)) continue;
        const slash = key.indexOf("/", prefix.length);
        if (slash !== -1) children.add(key.slice(prefix.length, slash));
      }
      return [...children].toSorted();
    },
    async putObject(input) {
      const bytes =
        input.body.kind === "bytes" ? input.body.bytes : await Bun.file(input.body.path).bytes();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== input.sha256) throw new Error(`BadDigest: ${input.key}`);
      if (objects.has(input.key)) return "exists";
      objects.set(input.key, { bytes, sha256, tags: { ...input.tags } });
      return "created";
    },
    async putObjectTags(key, tags) {
      stored(key).tags = { ...tags };
    },
    runLifecycle() {
      for (const [key, { tags }] of objects) {
        if (tags.retention === "dev" && tags.object === "payload") objects.delete(key);
      }
    },
  };
}

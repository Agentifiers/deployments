import { describe, expect, test } from "bun:test";
import { memoryRegistryStore } from "./memory-store.ts";
import { type ObjectBody, readObjectBytes } from "./store.ts";

const bytes = (text: string): ObjectBody => ({
  bytes: new TextEncoder().encode(text),
  kind: "bytes",
});
const helloSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const otherSha256 = "4d1a4ee1d15ea6d4c8e3dbca7b4b2a6d7a5a3d9f17e1b8c0d0f7b1e4f6d9c2a1";

describe("in-memory registry store", () => {
  test("creates once and answers a second put of the key like S3's 412", async () => {
    const store = memoryRegistryStore();
    expect(
      await store.putObject({
        body: bytes("hello"),
        key: "releases/a/x",
        sha256: helloSha256,
        tags: {},
      }),
    ).toBe("created");
    expect(
      await store.putObject({
        body: bytes("hello"),
        key: "releases/a/x",
        sha256: helloSha256,
        tags: {},
      }),
    ).toBe("exists");
    expect(new TextDecoder().decode(await readObjectBytes(store, "releases/a/x"))).toBe("hello");
    expect(await store.headObject("releases/a/x")).toEqual({ sha256: helloSha256, sizeBytes: 5 });
  });

  test("rejects a body whose checksum is not the declared SHA-256", async () => {
    const store = memoryRegistryStore();
    expect(
      store.putObject({ body: bytes("hello"), key: "releases/a/x", sha256: otherSha256, tags: {} }),
    ).rejects.toThrow("BadDigest: releases/a/x");
    expect(await store.headObject("releases/a/x")).toBeUndefined();
  });

  test("lists child names and replaces tag sets", async () => {
    const store = memoryRegistryStore();
    for (const key of ["releases/b/x", "releases/a/x", "releases/a/images/y", "other/z"]) {
      await store.putObject({
        body: bytes("hello"),
        key,
        sha256: helloSha256,
        tags: { retention: "dev" },
      });
    }
    expect(await store.listChildNames("releases/")).toEqual(["a", "b"]);
    expect(await store.listChildNames("releases/a/")).toEqual(["images"]);
    await store.putObjectTags("releases/a/x", { retention: "customer" });
    expect(await store.getObjectTags("releases/a/x")).toEqual({ retention: "customer" });
    expect(await store.getObjectTags("releases/b/x")).toEqual({ retention: "dev" });
  });

  test("the lifecycle removes only objects tagged retention=dev and object=payload", async () => {
    const store = memoryRegistryStore();
    const tagged = {
      "releases/a/payload": { object: "payload", retention: "dev" },
      "releases/a/record": { retention: "dev" },
      "releases/a/retained": { object: "payload", retention: "customer" },
    };
    for (const [key, tags] of Object.entries(tagged)) {
      await store.putObject({ body: bytes("hello"), key, sha256: helloSha256, tags });
    }
    store.runLifecycle();
    expect(await store.headObject("releases/a/payload")).toBeUndefined();
    expect(await store.headObject("releases/a/record")).toEqual({
      sha256: helloSha256,
      sizeBytes: 5,
    });
    expect(await store.headObject("releases/a/retained")).toEqual({
      sha256: helloSha256,
      sizeBytes: 5,
    });
  });
});

import type { Readable } from "node:stream";
import type { AppId, AppSlug } from "./names.ts";

export interface SlugDirectory {
  readonly put: (slug: AppSlug, appId: AppId) => Promise<void>;
  readonly remove: (slug: AppSlug) => Promise<void>;
}

export interface AppObjectStore {
  readonly putObject: (input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Readable;
    readonly contentType: string;
  }) => Promise<void>;
  /** One page of at most 1000 keys, the most one `deleteObjects` call accepts. */
  readonly listObjects: (input: {
    readonly bucket: string;
    readonly prefix: string;
  }) => Promise<readonly string[]>;
  readonly deleteObjects: (input: {
    readonly bucket: string;
    readonly keys: readonly string[];
  }) => Promise<void>;
}

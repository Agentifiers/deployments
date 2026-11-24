import { createHash } from "node:crypto";
import type { BrainSource } from "@deployments-ai/brains";
import type { BrainGitHubSnapshot } from "./sync-runtime.ts";

const MAX_FILE_BYTES = 1 * 1_024 * 1_024;
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 32 * 1_024 * 1_024;
const allowedExtensions = new Set([
  ".adoc",
  ".csv",
  ".json",
  ".markdown",
  ".md",
  ".rst",
  ".txt",
  ".yaml",
  ".yml",
]);

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub ${label} response is invalid.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`GitHub ${label} is missing.`);
  }
  return value.trim();
}

function repositoryConfiguration(source: BrainSource) {
  const configuration = record(source.configuration, "source configuration");
  const owner = text(configuration.owner, "repository owner");
  const repository = text(configuration.repository, "repository name");
  const ref = configuration.ref === undefined ? "HEAD" : text(configuration.ref, "repository ref");
  const safe = /^[A-Za-z0-9_.-]{1,100}$/u;
  if (!safe.test(owner) || !safe.test(repository) || ref.length > 255) {
    throw new TypeError("GitHub Brain source repository configuration is invalid.");
  }
  return { owner, ref, repository };
}

function apiPath(...segments: readonly string[]) {
  return `https://api.github.com/${segments.map(encodeURIComponent).join("/")}`;
}

function extension(path: string) {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function gitBlobSha(bytes: Uint8Array) {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export function makeGitHubBrainConnector(
  fetchImplementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): (input: {
  readonly accessToken: string;
  readonly signal?: AbortSignal;
  readonly source: BrainSource;
}) => Promise<BrainGitHubSnapshot> {
  return async ({ accessToken, signal, source }) => {
    if (!accessToken.trim()) throw new TypeError("GitHub Brain access token is empty.");
    const config = repositoryConfiguration(source);
    const request = async (url: string) => {
      const target = new URL(url);
      if (target.origin !== "https://api.github.com") {
        throw new TypeError("GitHub Brain request escaped the approved API origin.");
      }
      const response = await fetchImplementation(target, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "deployments-ai-brain/1",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`GitHub Brain request failed with status ${response.status}.`);
      }
      return response.json() as Promise<unknown>;
    };

    const commit = record(
      await request(apiPath("repos", config.owner, config.repository, "commits", config.ref)),
      "commit",
    );
    const commitSha = text(commit.sha, "commit SHA");
    const commitData = record(commit.commit, "commit metadata");
    const committer = record(commitData.committer, "commit author");
    const committedAt = text(committer.date, "commit timestamp");
    const tree = record(commitData.tree, "commit tree");
    const treeSha = text(tree.sha, "tree SHA");
    const treeResponse = record(
      await request(
        `${apiPath("repos", config.owner, config.repository, "git", "trees", treeSha)}?recursive=1`,
      ),
      "tree",
    );
    if (treeResponse.truncated === true) {
      throw new Error(
        "GitHub Brain repository tree is truncated and cannot be synchronized safely.",
      );
    }
    if (!Array.isArray(treeResponse.tree))
      throw new Error("GitHub Brain tree entries are missing.");
    const entries = treeResponse.tree
      .flatMap((value) => {
        const entry = record(value, "tree entry");
        if (entry.type !== "blob") return [];
        const path = text(entry.path, "tree path");
        const sha = text(entry.sha, "blob SHA");
        const size = entry.size;
        if (
          path.length > 1_024 ||
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 1 ||
          size > MAX_FILE_BYTES ||
          !allowedExtensions.has(extension(path))
        ) {
          return [];
        }
        return [{ path, sha, size }];
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    if (entries.length > MAX_FILES) {
      throw new Error(`GitHub Brain source exceeds the ${MAX_FILES}-file synchronization limit.`);
    }
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("GitHub Brain source exceeds the synchronization byte limit.");
    }
    return {
      committedAt,
      cursor: commitSha,
      files: entries.map((entry) => ({
        ...entry,
        read: async (readSignal?: AbortSignal) => {
          const blob = record(
            await request(
              apiPath("repos", config.owner, config.repository, "git", "blobs", entry.sha),
            ),
            "blob",
          );
          if (readSignal?.aborted) throw readSignal.reason ?? new Error("GitHub sync aborted.");
          if (blob.encoding !== "base64" || typeof blob.content !== "string") {
            throw new Error("GitHub Brain blob is not base64 encoded.");
          }
          const bytes = Buffer.from(blob.content.replaceAll(/\s/gu, ""), "base64");
          if (bytes.byteLength !== entry.size || gitBlobSha(bytes) !== entry.sha.toLowerCase()) {
            throw new Error("GitHub Brain blob failed immutable SHA verification.");
          }
          return bytes;
        },
      })),
    };
  };
}

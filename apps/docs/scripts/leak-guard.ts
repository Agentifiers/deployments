import { parseArgs } from "node:util";

export const CONTENT_PENDING_MARKER = "DOCS_CONTENT_PENDING";

/**
 * Names that must never be published are private to each operator, so the
 * repository holds no list of them. An operator points this variable at a JSON
 * file of digests: `{ "names": [...], "leadWords": [...] }`.
 */
export const VERTICAL_NAME_DIGESTS_FILE_ENV = "DOCS_LEAK_GUARD_DIGESTS_FILE";

const DIGEST = /^[0-9a-f]{16}$/u;

const ULID_SPEC_EXAMPLE = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

const MAX_NAME_WORDS = 3;
const ACCOUNT_CONTEXT_RADIUS = 48;
const ACCOUNT_CONTEXT =
  /account|aws|amazonaws|arn:|\biam\b|\becr\b|\bsts\b|principal|owner[_-]?id/iu;
const WORD_SEPARATOR = /^[\s_:-]{1,3}$/u;

export type LeakKind = "aws-account-id" | "aws-arn" | "content-pending" | "ulid" | "vertical-name";

export interface Leak {
  readonly kind: LeakKind;
  readonly match: string;
  readonly line: number;
  readonly column: number;
}

export interface VerticalNameDigests {
  readonly names: ReadonlySet<string>;
  readonly leadWords: ReadonlySet<string>;
}

export const NO_VERTICAL_NAME_DIGESTS: VerticalNameDigests = {
  names: new Set(),
  leadWords: new Set(),
};

function digestSet(document: unknown, field: keyof VerticalNameDigests, path: string) {
  const value =
    typeof document === "object" && document !== null ? Reflect.get(document, field) : undefined;
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && DIGEST.test(entry))
  ) {
    throw new Error(
      `${path}: \`${field}\` must be an array of 16-character lowercase hex digests.`,
    );
  }
  return new Set<string>(value);
}

/** Reads the digest file named by DOCS_LEAK_GUARD_DIGESTS_FILE; without it no name is checked. */
export async function loadVerticalNameDigests(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<VerticalNameDigests> {
  const path = environment[VERTICAL_NAME_DIGESTS_FILE_ENV]?.trim();
  if (!path) return NO_VERTICAL_NAME_DIGESTS;
  const document: unknown = await Bun.file(path).json();
  return {
    names: digestSet(document, "names", path),
    leadWords: digestSet(document, "leadWords", path),
  };
}

const PATTERNS: readonly {
  readonly kind: Exclude<LeakKind, "aws-account-id" | "vertical-name">;
  readonly pattern: RegExp;
}[] = [
  { kind: "content-pending", pattern: new RegExp(CONTENT_PENDING_MARKER, "gu") },
  { kind: "aws-arn", pattern: /\barn:aws[a-z-]*:[^\s"'<>]*/giu },
  { kind: "ulid", pattern: /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/gu },
];

const digestCache = new Map<string, string>();

function verticalNameDigest(phrase: string): string {
  const cached = digestCache.get(phrase);
  if (cached) return cached;
  const digest = new Bun.CryptoHasher("sha256").update(phrase).digest("hex").slice(0, 16);
  digestCache.set(phrase, digest);
  return digest;
}

export function verticalNameDigestEntries(name: string): {
  readonly names: readonly string[];
  readonly leadWords: readonly string[];
} {
  const [first, ...rest] = name.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  if (first === undefined || rest.length >= MAX_NAME_WORDS) {
    throw new Error(`A vertical name needs 1 to ${MAX_NAME_WORDS} words.`);
  }
  if (rest.length === 0) return { names: [verticalNameDigest(first)], leadWords: [] };
  const words = [first, ...rest];
  return {
    names: [verticalNameDigest(words.join(" ")), verticalNameDigest(words.join(""))],
    leadWords: [verticalNameDigest(first)],
  };
}

function position(text: string, index: number): Pick<Leak, "column" | "line"> {
  const before = text.slice(0, index);
  return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

function verticalNameLeaks(text: string, digests: VerticalNameDigests): Leak[] {
  const words = Array.from(text.matchAll(/[A-Za-z0-9]+/gu), (match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const leaks: Leak[] = [];
  words.forEach((first, index) => {
    if (digests.names.has(verticalNameDigest(first.word))) {
      leaks.push({
        kind: "vertical-name",
        match: text.slice(first.start, first.end),
        ...position(text, first.start),
      });
    }
    if (!digests.leadWords.has(verticalNameDigest(first.word))) return;
    for (let length = 2; length <= MAX_NAME_WORDS; length += 1) {
      const phrase = words.slice(index, index + length);
      const last = phrase.at(-1);
      if (phrase.length !== length || !last) return;
      const joined = phrase.every(
        (word, offset) =>
          offset === 0 || WORD_SEPARATOR.test(text.slice(phrase[offset - 1]?.end, word.start)),
      );
      if (!joined) return;
      if (digests.names.has(verticalNameDigest(phrase.map(({ word }) => word).join(" ")))) {
        leaks.push({
          kind: "vertical-name",
          match: text.slice(first.start, last.end),
          ...position(text, first.start),
        });
      }
    }
  });
  return leaks;
}

export function findLeaks(text: string, digests: VerticalNameDigests): readonly Leak[] {
  const leaks = verticalNameLeaks(text, digests);
  for (const { kind, pattern } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (kind === "ulid" && match[0] === ULID_SPEC_EXAMPLE) continue;
      leaks.push({ kind, match: match[0], ...position(text, match.index) });
    }
  }
  for (const match of text.matchAll(/\b\d{12}\b/gu)) {
    const window = text.slice(
      Math.max(0, match.index - ACCOUNT_CONTEXT_RADIUS),
      match.index + match[0].length + ACCOUNT_CONTEXT_RADIUS,
    );
    if (ACCOUNT_CONTEXT.test(window)) {
      leaks.push({ kind: "aws-account-id", match: match[0], ...position(text, match.index) });
    }
  }
  return leaks.toSorted((left, right) => left.line - right.line || left.column - right.column);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { digest: { type: "string" } }, strict: true });
  if (values.digest === undefined) {
    console.error('Usage: bun apps/docs/scripts/leak-guard.ts --digest "<vertical name>"');
    process.exit(1);
  }
  console.log(JSON.stringify(verticalNameDigestEntries(values.digest)));
}

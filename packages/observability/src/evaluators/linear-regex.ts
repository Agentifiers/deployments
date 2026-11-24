import type { CodeOptions } from "ajv";
import { RE2JS } from "re2js";

type RegExpEngine = NonNullable<CodeOptions["regExp"]>;

/** A compiled user-supplied expression whose matching time is linear in the input length. */
export interface LinearRegex {
  readonly test: (input: string) => boolean;
}

const FLAG_BITS: Readonly<Record<string, number>> = {
  i: RE2JS.CASE_INSENSITIVE,
  m: RE2JS.MULTILINE,
  s: RE2JS.DOTALL,
  // RE2 always matches by code point, so the JavaScript `u` flag needs no translation.
  u: 0,
};

/** The pattern is valid ECMAScript but uses a construct the linear-time engine cannot run. */
export class UnsupportedRegexError extends Error {
  override readonly name = "UnsupportedRegexError";
}

/**
 * Compiles an ECMAScript pattern on RE2, which matches in time linear in the input and cannot
 * backtrack catastrophically. Throws `SyntaxError` for invalid ECMAScript and
 * `UnsupportedRegexError` for constructs RE2 cannot run in linear time (backreferences,
 * lookaround) or does not support.
 */
export function compileLinearRegex(pattern: string, flags = ""): LinearRegex {
  new RegExp(pattern, flags);
  let bits = 0;
  for (const flag of flags) {
    const bit = FLAG_BITS[flag];
    if (bit === undefined)
      throw new UnsupportedRegexError(`the regular expression flag "${flag}" is not supported`);
    bits |= bit;
  }
  // RE2's translation drops the escape from `\k` and keeps `\8`/`\9` literal, silently turning
  // ECMAScript backreferences into literal text, so reject every backreference escape here.
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "\\") continue;
    index += 1;
    if (/[1-9k]/u.test(pattern[index] ?? ""))
      throw new UnsupportedRegexError(`backreference \`\\${pattern[index]}\``);
  }
  try {
    return RE2JS.compile(RE2JS.translateRegExp(pattern), bits);
  } catch (cause) {
    throw new UnsupportedRegexError(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Ajv `code.regExp` engine so schema `pattern` and `patternProperties` match in linear time. */
export const linearRegExpEngine: RegExpEngine = Object.assign(
  (pattern: string, flags: string) => {
    const expression = compileLinearRegex(pattern, flags);
    // Ajv keys compiled patterns by `toString()`.
    return {
      test: (input: string) => expression.test(input),
      toString: () => `/${pattern}/${flags}`,
    };
  },
  { code: "linearRegExp" },
);

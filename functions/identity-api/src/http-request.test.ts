import { expect, test } from "bun:test";
import { parseForm } from "./http-request.ts";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

test("a form larger than the default limit is accepted under a raised limit and refused above it", () => {
  const body = `SAMLResponse=${"a".repeat(20_000)}&RelayState=r1`;

  expect(() => parseForm({ body, headers: FORM })).toThrow(
    expect.objectContaining({ status: 413 }),
  );
  expect(parseForm({ body, headers: FORM }, 262_144)).toEqual({
    RelayState: "r1",
    SAMLResponse: "a".repeat(20_000),
  });
  expect(() => parseForm({ body, headers: FORM }, body.length - 1)).toThrow(
    expect.objectContaining({ status: 413 }),
  );
});

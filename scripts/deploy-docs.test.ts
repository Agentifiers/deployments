import { describe, expect, test } from "bun:test";
import { destructiveChanges, parseArguments } from "./deploy-docs.ts";

describe("deploy-docs", () => {
  test("reports every planned delete, including replacements in either order", () => {
    const plan = {
      format_version: "1.2",
      resource_changes: [
        { address: "module.docs_site.aws_s3_bucket.site", change: { actions: ["create"] } },
        {
          address: "module.docs_site.aws_cloudfront_distribution.site",
          change: { actions: ["update"] },
        },
        {
          address: "module.docs_site.data.aws_iam_policy_document.site",
          change: { actions: ["read"] },
        },
        { address: "module.docs_site.aws_s3_bucket_policy.site", change: { actions: ["no-op"] } },
        {
          address: "module.docs_site.aws_acm_certificate.site",
          change: { actions: ["create", "delete"] },
        },
        {
          address: "module.docs_site.aws_cloudfront_function.directory_index",
          change: { actions: ["delete", "create"] },
        },
        {
          address: 'module.docs_site.aws_route53_record.alias["AAAA"]',
          change: { actions: ["delete"] },
        },
      ],
    };
    expect(destructiveChanges(plan)).toEqual([
      "module.docs_site.aws_acm_certificate.site",
      "module.docs_site.aws_cloudfront_function.directory_index",
      'module.docs_site.aws_route53_record.alias["AAAA"]',
    ]);
  });

  test("rejects a plan document without change actions", () => {
    expect(() =>
      destructiveChanges({ resource_changes: [{ address: "aws_s3_bucket.site", change: {} }] }),
    ).toThrow("actions");
  });

  const site = ["--root", "docs-site/dev", "--backend-config", "/state/docs-site.hcl"];

  test("builds and refuses replacements unless told otherwise", () => {
    expect(parseArguments(site, "/infra")).toEqual({
      allowReplace: false,
      backendConfig: "/state/docs-site.hcl",
      build: true,
      kind: "deploy",
      root: "/infra/docs-site/dev",
    });
    expect(parseArguments([...site, "--skip-build", "--allow-replace"], "/infra")).toEqual({
      allowReplace: true,
      backendConfig: "/state/docs-site.hcl",
      build: false,
      kind: "deploy",
      root: "/infra/docs-site/dev",
    });
  });

  test("prints help without requiring the root", () => {
    expect(parseArguments(["--skip-build", "--help"])).toEqual({ kind: "help" });
    expect(parseArguments(["-h"])).toEqual({ kind: "help" });
  });

  test("requires the root and its backend configuration", () => {
    expect(() => parseArguments([])).toThrow("--root <dir> is required.");
    expect(() => parseArguments(["--root", "docs-site/dev"])).toThrow(
      "--backend-config <file> is required.",
    );
    expect(() => parseArguments(["--backend-config", "docs-site.hcl", "--root", " "])).toThrow(
      "--root <dir> is required.",
    );
    expect(() => parseArguments([...site, "--root"])).toThrow("--root");
  });

  test("rejects unknown flags and positionals", () => {
    expect(() => parseArguments([...site, "--skip-builds"])).toThrow("--skip-builds");
    expect(() => parseArguments([...site, "extra"])).toThrow("extra");
  });
});

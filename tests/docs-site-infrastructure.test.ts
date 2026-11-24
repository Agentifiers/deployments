import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  loadViewerRequestHandler,
  loadViewerRequestRewrite,
} from "../apps/docs/scripts/viewer-request.ts";
import { readTerraformFiles } from "./terraform-files.ts";

const site = readTerraformFiles("infrastructure/modules/docs-site", "");

function block(source: string, header: string) {
  const start = source.indexOf(`${header} {`);
  if (start === -1) throw new Error(`Missing ${header}`);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}

function hclString(source: string, name: string) {
  const value = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "mu").exec(source)?.[1];
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

function hclNumber(source: string, name: string) {
  return Number(new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)`, "mu").exec(source)?.[1]);
}

const distribution = block(site, 'resource "aws_cloudfront_distribution" "site"');

describe("docs site infrastructure", () => {
  test("serves CloudFront with a us-east-1 certificate only after DNS validation", () => {
    expect(block(site, 'resource "aws_acm_certificate" "site"')).toContain(
      "provider = aws.us_east_1",
    );
    expect(block(site, 'resource "aws_acm_certificate_validation" "site"')).toContain(
      "provider = aws.us_east_1",
    );
    expect(distribution).toMatch(
      /acm_certificate_arn\s+=\s+aws_acm_certificate_validation\.site\.certificate_arn\n/u,
    );
  });

  test("keeps the bucket private and readable only by its own distribution", () => {
    const publicAccess = block(site, 'resource "aws_s3_bucket_public_access_block" "site"');
    for (const setting of [
      "block_public_acls",
      "block_public_policy",
      "ignore_public_acls",
      "restrict_public_buckets",
    ]) {
      expect(publicAccess).toMatch(new RegExp(`${setting}\\s+= true\\n`, "u"));
    }
    expect(block(site, 'resource "aws_s3_bucket_ownership_controls" "site"')).toContain(
      'object_ownership = "BucketOwnerEnforced"',
    );

    const allows = block(site, 'data "aws_iam_policy_document" "site"')
      .split("statement {")
      .filter((statement) => statement.includes('effect    = "Allow"'));
    expect(allows).toHaveLength(1);
    expect(allows[0]).toContain('actions   = ["s3:GetObject"]');
    expect(allows[0]).toContain('identifiers = ["cloudfront.amazonaws.com"]');
    expect(allows[0]).toContain('variable = "AWS:SourceArn"');
    expect(allows[0]).toContain("values   = [aws_cloudfront_distribution.site.arn]");

    expect(distribution).toContain(
      "origin_access_control_id = aws_cloudfront_origin_access_control.site.id",
    );
    expect(site).not.toContain("aws_s3_bucket_website_configuration");
    expect(site).not.toContain("aws_s3_bucket_acl");
  });

  test("never expires published objects, unlike the preview sites", () => {
    const previewSites = readTerraformFiles("infrastructure/modules/preview-sites", "");
    expect(previewSites).toContain('resource "aws_s3_bucket_lifecycle_configuration"');
    expect(previewSites).toContain("expiration {");
    expect(site).not.toContain('resource "aws_s3_bucket_lifecycle_configuration"');
    expect(site).not.toContain("expiration {");
  });

  test("rewrites directory and extensionless paths to index.html on viewer request", () => {
    const rewrite = loadViewerRequestRewrite();

    expect(rewrite("/")).toBe("/index.html");
    expect(rewrite("/docs/")).toBe("/docs/index.html");
    expect(rewrite("/docs/cli/reference")).toBe("/docs/cli/reference/index.html");
    expect(rewrite("/_next/static/chunks/app-3f2a.js")).toBe("/_next/static/chunks/app-3f2a.js");
    expect(rewrite("/404.html")).toBe("/404.html");
    expect(rewrite("/api/search.json")).toBe("/api/search.json");

    const association = distribution.slice(distribution.indexOf("function_association"));
    expect(association).toMatch(/event_type\s+= "viewer-request"/u);
    expect(association).toMatch(/function_arn\s+= aws_cloudfront_function\.directory_index\.arn/u);
  });

  test("redirects every problem details type URI to the error code list", () => {
    const handle = loadViewerRequestHandler();
    const redirect = {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: "/docs/api/errors/#common-codes" } },
    };
    for (const uri of ["/errors", "/errors/", "/errors/insufficient-scope", "/errors/a/b"]) {
      expect(handle(uri)).toEqual(redirect);
    }
    const rewrite = loadViewerRequestRewrite();
    expect(rewrite("/errorsx")).toBe("/errorsx/index.html");
    expect(rewrite("/docs/api/errors/")).toBe("/docs/api/errors/index.html");
  });

  test("answers missing objects with the exported 404 page and status 404", () => {
    const errorResponses = [...distribution.matchAll(/custom_error_response \{([^}]*)\}/gu)].map(
      ([, body = ""]) => ({
        errorCode: hclNumber(body, "error_code"),
        page: hclString(body, "response_page_path"),
        responseCode: hclNumber(body, "response_code"),
      }),
    );
    expect(errorResponses).toEqual([
      { errorCode: 403, page: "/404.html", responseCode: 404 },
      { errorCode: 404, page: "/404.html", responseCode: 404 },
    ]);
  });

  test("lets the edge keep every Cache-Control max-age the deploy script writes", () => {
    const policy = block(site, 'resource "aws_cloudfront_cache_policy" "site"');
    const maxAges = [
      ...readFileSync("scripts/deploy-docs.ts", "utf8").matchAll(/max-age=(\d+)/gu),
    ].map(([, age]) => Number(age));
    expect(maxAges).toContain(31536000);
    for (const age of maxAges) {
      expect(age).toBeGreaterThanOrEqual(hclNumber(policy, "min_ttl"));
      expect(age).toBeLessThanOrEqual(hclNumber(policy, "max_ttl"));
    }
  });

  test("creates no IAM principals or policies", () => {
    expect(site).not.toMatch(/resource "aws_iam_/u);
  });
});

import { describe, expect, test } from "bun:test";
import { parseHumanVerificationConfig } from "./human-verification-config.ts";

const configured = {
  responseField: "challenge-response",
  scriptUrl: "https://challenge.example/v1/api.js",
  secretParameterArn: "arn:aws:ssm:us-east-2:123456789012:parameter/identity/challenge-secret",
  siteKey: "0x4AAAAAAA-site_key",
  verifyUrl: "https://challenge.example/v1/siteverify",
  widgetClass: "challenge",
  widgetOrigins: ["https://*.widget.example"],
};

describe("human verification configuration", () => {
  test("is absent when the install sets nothing", () => {
    expect(parseHumanVerificationConfig(undefined)).toBeUndefined();
    expect(parseHumanVerificationConfig(JSON.stringify(configured))?.widget.siteKey).toBe(
      "0x4AAAAAAA-site_key",
    );
  });

  test("parses the install configuration into a verifier configuration", () => {
    expect(parseHumanVerificationConfig(JSON.stringify(configured))).toEqual({
      secretParameterArn: "arn:aws:ssm:us-east-2:123456789012:parameter/identity/challenge-secret",
      verifyUrl: "https://challenge.example/v1/siteverify",
      widget: {
        responseField: "challenge-response",
        scriptUrl: "https://challenge.example/v1/api.js",
        siteKey: "0x4AAAAAAA-site_key",
        widgetClass: "challenge",
        widgetOrigins: ["https://*.widget.example"],
      },
    });
  });

  test.each([
    {
      responseField: "cf-turnstile-response",
      scriptUrl: "https://challenges.cloudflare.com/turnstile/v0/api.js",
      secretParameterArn:
        "arn:aws:ssm:us-east-2:123456789012:parameter/identity/human-verification-secret",
      siteKey: "0x4AAAAAAABkMYinukE8nzY",
      verifyUrl: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      widgetClass: "cf-turnstile",
      widgetOrigins: [],
    },
    {
      responseField: "h-captcha-response",
      scriptUrl: "https://js.hcaptcha.com/1/api.js",
      secretParameterArn: "arn:aws:ssm:us-east-2:123456789012:parameter/identity/hcaptcha-secret",
      siteKey: "10000000-ffff-ffff-ffff-000000000001",
      verifyUrl: "https://api.hcaptcha.com/siteverify",
      widgetClass: "h-captcha",
      widgetOrigins: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
    },
  ])("parses the documented $widgetClass example as OpenTofu passes it", (documented) => {
    const { secretParameterArn, verifyUrl, ...widget } = documented;
    expect(parseHumanVerificationConfig(JSON.stringify(documented))).toEqual({
      secretParameterArn,
      verifyUrl,
      widget,
    });
  });

  test.each([
    [
      { scriptUrl: "http://challenge.example/api.js" },
      "Human verification scriptUrl must be an HTTPS URL.",
    ],
    [{ verifyUrl: "not a url" }, "Human verification verifyUrl must be an HTTPS URL."],
    [
      { verifyUrl: "https://user:pass@challenge.example/v1/siteverify" },
      "Human verification verifyUrl must be an HTTPS URL.",
    ],
    [
      { verifyUrl: "https://challenge.example:65536/v1/siteverify" },
      "Human verification verifyUrl must be an HTTPS URL.",
    ],
    [
      { scriptUrl: "https://xn--zz.example/api.js" },
      "Human verification scriptUrl must be an HTTPS URL.",
    ],
    [
      { scriptUrl: "https://challenge.999/api.js" },
      "Human verification scriptUrl must be an HTTPS URL.",
    ],
    [
      { widgetOrigins: ["https://widget.example:123456"] },
      "Human verification widgetOrigins is invalid.",
    ],
    [{ widgetClass: "c".repeat(65) }, "Human verification widgetClass is invalid."],
    [{ responseField: "r".repeat(65) }, "Human verification responseField is invalid."],
    [{ siteKey: "k".repeat(257) }, "Human verification siteKey is invalid."],
    [
      { widgetOrigins: ["https://widget.example; script-src *"] },
      "Human verification widgetOrigins is invalid.",
    ],
    [{ widgetClass: 'challenge" onload="x' }, "Human verification widgetClass is invalid."],
    [{ siteKey: "" }, "Human verification siteKey is invalid."],
    [
      { secretParameterArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:challenge" },
      "Human verification secretParameterArn must name an SSM parameter.",
    ],
    [
      { provider: "named-vendor" },
      "Human verification configuration must be an object with known fields.",
    ],
  ])("refuses %j at cold start", (override, message) => {
    expect(() =>
      parseHumanVerificationConfig(JSON.stringify({ ...configured, ...override })),
    ).toThrow(message);
  });
});

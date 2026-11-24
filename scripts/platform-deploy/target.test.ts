import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "./process.ts";
import { decodeDeploymentTarget, loadDeploymentTarget } from "./target.ts";

const directory = mkdtempSync(join(tmpdir(), "platform-target-"));
afterAll(() => rmSync(directory, { force: true, recursive: true }));

const base = {
  aws: { accountId: "123456789012", region: "us-east-2" },
  name: "byoc-acme",
  profile: "platform-customer",
  terraform: { stateBucket: "acme-terraform-state" },
  version: 1,
};

describe("deployment target decoding", () => {
  test("applies the default state key, ECR repositories, root, and profile shape", async () => {
    const target = await decodeDeploymentTarget(base, directory);
    expect(target.terraform.stateKey).toBe("platform/byoc-acme/terraform.tfstate");
    expect(target.terraform.varFiles).toEqual([]);
    expect(target.terraform.root).toBe(
      join(repositoryRoot, "infrastructure/environments/customer"),
    );
    expect(target.ecrRepositories["durable-streams"]).toBe(
      "deployments-ai/platform/durable-streams",
    );
    expect(target.ecrRepositories["app-gateway"]).toBe("deployments-ai/platform/app-gateway");
    expect(target.ecrRepositories["model-gateway"]).toBe("deployments-ai/platform/model-gateway");
    expect(target.profileName).toBe("platform-customer");
    expect(target.profile).toEqual({
      allowMissingLambdas: true,
      images: [
        "agent-worker",
        "app-gateway",
        "bifrost",
        "durable-streams",
        "firecrawl",
        "model-gateway",
        "observability-hot-plane",
        "stream-gateway",
        "web-tools-proxy",
      ],
      lambdaMicrovm: true,
      terraformRoot: "infrastructure/environments/customer",
    });
  });

  test("lets a target turn the profile's Lambda MicroVM steps off", async () => {
    const optedOut = await decodeDeploymentTarget({ ...base, lambdaMicrovm: false }, directory);
    expect(optedOut.profile.lambdaMicrovm).toBe(false);
    expect(optedOut.profile.images).toContain("firecrawl");
  });

  test("publishes the sandbox image unless the target picks the desktop variant", async () => {
    expect((await decodeDeploymentTarget(base, directory)).lambdaMicrovmImage).toBe("sandbox");
    const desktop = await decodeDeploymentTarget(
      { ...base, lambdaMicrovmImage: "desktop" },
      directory,
    );
    expect(desktop.lambdaMicrovmImage).toBe("desktop");
    expect(
      decodeDeploymentTarget(
        { ...base, lambdaMicrovm: false, lambdaMicrovmImage: "desktop" },
        directory,
      ),
    ).rejects.toThrow("publishes no Lambda MicroVM image");
  });

  test("resolves terraform.root against the target file's directory", async () => {
    const targets = join(directory, "operator", "targets");
    mkdirSync(join(directory, "operator", "environments", "prod"), { recursive: true });
    mkdirSync(targets, { recursive: true });
    const path = join(targets, "prod.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...base,
        name: "prod",
        profile: "platform-prod",
        terraform: { root: "../environments/prod", stateBucket: "acme-terraform-state" },
      }),
    );
    const target = await loadDeploymentTarget(path);
    expect(target.terraform.root).toBe(join(directory, "operator", "environments", "prod"));
    expect(target.profile.terraformRoot).toBeUndefined();
    expect(target.profile.lambdaMicrovm).toBe(true);
  });

  test("lets terraform.root replace the in-repo root of a profile that has one", async () => {
    const root = join(directory, "customer-root");
    mkdirSync(root, { recursive: true });
    const target = await decodeDeploymentTarget(
      { ...base, terraform: { root: "customer-root", stateBucket: "acme-terraform-state" } },
      directory,
    );
    expect(target.terraform.root).toBe(root);
  });

  test("requires terraform.root for profiles whose root is not in this repository", () => {
    for (const profile of ["platform-dev", "platform-prod"]) {
      expect(decodeDeploymentTarget({ ...base, profile }, directory)).rejects.toThrow(
        `uses profile ${profile}, whose OpenTofu root is not in this repository; set terraform.root`,
      );
    }
  });

  test("rejects a terraform.root that is not a directory", () => {
    writeFileSync(join(directory, "root-file"), "");
    for (const root of ["absent-root", "root-file"]) {
      expect(
        decodeDeploymentTarget(
          { ...base, terraform: { root, stateBucket: "acme-terraform-state" } },
          directory,
        ),
      ).rejects.toThrow(`OpenTofu root ${join(directory, root)} does not exist`);
    }
  });

  test("keeps explicit state keys and ECR overrides and resolves var files", async () => {
    writeFileSync(
      join(directory, "inputs.tfvars.json"),
      '{"billing_alert_email":"ops@example.com"}',
    );
    const target = await decodeDeploymentTarget(
      {
        ...base,
        ecrRepositories: {
          "app-gateway": "acme/app-gateway",
          "web-tools-proxy": "acme/web-tools-proxy",
        },
        terraform: {
          stateBucket: "acme-terraform-state",
          stateKey: "custom/state.tfstate",
          varFiles: ["inputs.tfvars.json"],
        },
      },
      directory,
    );
    expect(target.terraform.stateKey).toBe("custom/state.tfstate");
    expect(target.terraform.varFiles).toEqual([join(directory, "inputs.tfvars.json")]);
    expect(target.ecrRepositories["app-gateway"]).toBe("acme/app-gateway");
    expect(target.ecrRepositories["web-tools-proxy"]).toBe("acme/web-tools-proxy");
    expect(target.ecrRepositories["observability-hot-plane"]).toBe(
      "deployments-ai/platform/observability-hot-plane",
    );
  });

  test("rejects an unknown profile", async () => {
    expect(
      decodeDeploymentTarget({ ...base, profile: "platform-staging" }, directory),
    ).rejects.toThrow("Invalid deployment target");
  });

  test("rejects an account ID that is not 12 digits", async () => {
    expect(
      decodeDeploymentTarget(
        { ...base, aws: { accountId: "12345", region: "us-east-2" } },
        directory,
      ),
    ).rejects.toThrow("Invalid deployment target");
  });

  test("rejects a malformed region and name", async () => {
    expect(
      decodeDeploymentTarget(
        { ...base, aws: { accountId: "123456789012", region: "ohio" } },
        directory,
      ),
    ).rejects.toThrow("Invalid deployment target");
    expect(decodeDeploymentTarget({ ...base, name: "Prod" }, directory)).rejects.toThrow(
      "Invalid deployment target",
    );
  });

  test("rejects unknown keys at any level", async () => {
    expect(decodeDeploymentTarget({ ...base, artifactBucket: "x" }, directory)).rejects.toThrow(
      "Invalid deployment target",
    );
    expect(
      decodeDeploymentTarget(
        { ...base, terraform: { stateBucket: "acme-terraform-state", region: "us-east-1" } },
        directory,
      ),
    ).rejects.toThrow("Invalid deployment target");
    expect(
      decodeDeploymentTarget({ ...base, ecrRepositories: { powersync: "x" } }, directory),
    ).rejects.toThrow("Invalid deployment target");
  });

  test("rejects missing var files and var files that are not JSON objects", async () => {
    expect(
      decodeDeploymentTarget(
        { ...base, terraform: { stateBucket: "acme-terraform-state", varFiles: ["absent.json"] } },
        directory,
      ),
    ).rejects.toThrow("does not exist");
    writeFileSync(join(directory, "array.json"), "[]");
    expect(
      decodeDeploymentTarget(
        { ...base, terraform: { stateBucket: "acme-terraform-state", varFiles: ["array.json"] } },
        directory,
      ),
    ).rejects.toThrow("must contain a JSON object");
  });
});

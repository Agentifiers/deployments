import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { publishedDistTags } from "./client-package-dist-tags.ts";
import { clientPackageMetadata, clientPackageRegistry } from "./client-package-metadata.ts";

const root = resolve(import.meta.dir, "..");

describe("client package release safety", () => {
  test("reads dist-tags through the exact staged package version", async () => {
    const commands: string[][] = [];
    const tags = await publishedDistTags({
      capture: async (command) => {
        commands.push([...command]);
        return {
          exitCode: 0,
          stderr: "",
          stdout: '{"next":"0.1.0-alpha.0"}',
        };
      },
      name: "@agentifiers/deployments-sdk",
      packageVersion: "0.1.0-alpha.0",
      registry: clientPackageRegistry,
    });

    expect(commands).toEqual([
      [
        "npm",
        "view",
        "@agentifiers/deployments-sdk@0.1.0-alpha.0",
        "dist-tags",
        "--json",
        "--registry",
        "https://registry.npmjs.org",
      ],
    ]);
    expect(tags).toEqual({ next: "0.1.0-alpha.0" });
  });

  test("stages public npmjs manifests that match the trusted publisher repository", () => {
    expect(clientPackageMetadata("packages/sdk")).toEqual({
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/Agentifiers/deployments.git",
        directory: "packages/sdk",
      },
      publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
    });
  });

  test("publishes only from main of the public repository through trusted publishing", async () => {
    const workflow = await Bun.file(resolve(root, ".github/workflows/release-packages.yml")).text();

    expect(workflow).toContain(
      "if: github.repository == 'Agentifiers/deployments' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("actions/workflows/ci.yml/runs?");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  test("passes the workflow dispatch tag outside shell source", async () => {
    const workflow = await Bun.file(resolve(root, ".github/workflows/release-packages.yml")).text();

    expect(workflow).toContain("DIST_TAG: ${{ inputs.dist_tag }}");
    expect(workflow).toContain('run: bun run packages:publish -- "$DIST_TAG"');
    expect(workflow).not.toMatch(/run:.*\$\{\{ inputs\.dist_tag \}\}/u);
  });

  test("documents prerelease entry and stable promotion", async () => {
    const documentation = await Bun.file(resolve(root, ".changeset/README.md")).text();

    expect(documentation).toContain("bun run changeset -- pre enter alpha");
    expect(documentation).toContain("bun run changeset -- pre exit");
  });

  test("pins the CommonJS-compatible Changesets human-id dependency", async () => {
    const manifest = (await Bun.file(resolve(root, "package.json")).json()) as {
      overrides?: Record<string, string>;
    };

    expect(manifest.overrides?.["human-id"]).toBe("4.1.1");
  });
});

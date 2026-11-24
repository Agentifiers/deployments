import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  latestManagedMicrovmImageVersion,
  microvmImageName,
  microvmVariantEntries,
  writeMicrovmArchive,
} from "./lambda-microvm-image.ts";

describe("Lambda MicroVM image publishing", () => {
  test("selects the newest AWS-managed base image version", () => {
    const imageArn = "arn:aws:lambda:us-east-2:aws:microvm-image:al2023-1";

    expect(
      latestManagedMicrovmImageVersion(imageArn, [
        {
          createdAt: new Date("2026-06-19T01:39:04.754Z"),
          imageArn,
          imageVersion: "0",
        },
        {
          createdAt: new Date("2026-07-16T01:35:51.854Z"),
          imageArn,
          imageVersion: "1",
        },
      ]),
    ).toBe("1");
  });

  test("rejects an empty or mismatched managed image response", () => {
    expect(() => latestManagedMicrovmImageVersion("expected", [])).toThrow(
      "AWS-managed Lambda MicroVM base image expected has no available version.",
    );
    expect(() =>
      latestManagedMicrovmImageVersion("expected", [
        {
          createdAt: new Date("2026-07-16T01:35:51.854Z"),
          imageArn: "other",
          imageVersion: "1",
        },
      ]),
    ).toThrow("AWS-managed Lambda MicroVM base image expected has no available version.");
  });

  test("builds the desktop variant from the sandbox Dockerfile plus its layer", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const entries = [
      ["Dockerfile", encode('FROM base\nCMD ["sandbox"]\n')],
      ["control_server.py", encode("server")],
      ["desktop/layer.Dockerfile", encode('RUN install-desktop\nCMD ["desktop"]\n')],
      ["desktop/start-desktop.sh", encode("start")],
    ] as const;
    const files = (variant: "sandbox" | "desktop") =>
      Object.fromEntries(
        microvmVariantEntries(entries, variant).map(([name, bytes]) => [
          name,
          new TextDecoder().decode(bytes),
        ]),
      );

    expect(files("sandbox")).toEqual({
      Dockerfile: 'FROM base\nCMD ["sandbox"]\n',
      "control_server.py": "server",
    });
    expect(files("desktop")).toEqual({
      Dockerfile: 'FROM base\nCMD ["sandbox"]\n\nRUN install-desktop\nCMD ["desktop"]\n',
      "control_server.py": "server",
      "desktop/layer.Dockerfile": 'RUN install-desktop\nCMD ["desktop"]\n',
      "desktop/start-desktop.sh": "start",
    });
    expect(() => microvmVariantEntries(entries.slice(0, 2), "desktop")).toThrow(
      "desktop/layer.Dockerfile",
    );
    const hash = "a".repeat(64);
    expect(microvmImageName(hash)).toBe(`deployments-ai-sandbox-${"a".repeat(24)}`);
    expect(microvmImageName(hash, "desktop")).toBe(
      `deployments-ai-sandbox-desktop-${"a".repeat(24)}`,
    );
  });

  test("archives exactly the listed build inputs under their nested relative paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "microvm-archive-test-"));
    try {
      const context = join(directory, "context");
      await mkdir(join(context, "browser", "node_modules"), { recursive: true });
      await writeFile(join(context, "Dockerfile"), "FROM scratch\n");
      await writeFile(join(context, "browser", "driver.ts"), "export {};\n");
      await writeFile(join(context, "browser", "node_modules", "ignored.js"), "ignored\n");
      const archive = join(directory, "context.zip");

      await writeMicrovmArchive(context, archive, ["Dockerfile", "browser/driver.ts"]);

      const listing = spawnSync(
        "python3",
        [
          "-c",
          "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))",
          archive,
        ],
        { encoding: "utf8" },
      );
      expect(listing.stdout.trim().split("\n")).toEqual(["Dockerfile", "browser/driver.ts"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

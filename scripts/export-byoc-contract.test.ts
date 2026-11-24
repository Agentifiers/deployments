import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terraformRequiredVariables } from "./export-byoc-contract.ts";

const parent = mkdtempSync(join(tmpdir(), "byoc-contract-"));
afterAll(() => rmSync(parent, { force: true, recursive: true }));

function terraformRoot(files: Readonly<Record<string, string>>) {
  const directory = mkdtempSync(join(parent, "root-"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
  return directory;
}

describe("customer root required variables", () => {
  test("lists variables without a top-level default and refuses shapes it cannot read", async () => {
    const root = terraformRoot({
      "variables.tf": `variable "operations" {
  type = object({
    default = string
  })

  validation {
    condition     = var.operations.default != ""
    error_message = "Set \${var.operations.default}."
  }
}

variable "alarm_prefix" {
  type    = string
  default = null
}

variable "empty" {}
`,
      "network.tf": `variable "network_cidr_block" {
  description = "A /16 block."
  type        = string
}

variable "availability_zones" {
  type    = list(string)
  default = []
}
`,
      "README.md": `variable "ignored" {}\n`,
    });
    expect(await terraformRequiredVariables(root)).toEqual([
      "empty",
      "network_cidr_block",
      "operations",
    ]);

    const inline = terraformRoot({ "inline.tf": `variable "region" { default = "us-east-2" }\n` });
    expect(terraformRequiredVariables(inline)).rejects.toThrow(
      `${join(inline, "inline.tf")} has a variable block that is not tofu fmt.`,
    );
    const heredoc = terraformRoot({
      "heredoc.tf": `variable "region" {\n  description = <<-EOT\n  default = "x"\n  EOT\n  type = string\n}\n`,
    });
    expect(terraformRequiredVariables(heredoc)).rejects.toThrow(
      `variable "region" in ${join(heredoc, "heredoc.tf")} has a heredoc the exporter cannot read.`,
    );
    const commented = terraformRoot({ "old.tf": `/*\nvariable "old" {}\n*/\n` });
    expect(terraformRequiredVariables(commented)).rejects.toThrow(
      `${join(commented, "old.tf")} has a block comment the exporter cannot read.`,
    );
    const json = terraformRoot({ "variables.tf.json": "{}\n" });
    expect(terraformRequiredVariables(json)).rejects.toThrow(
      `${join(json, "variables.tf.json")} is an OpenTofu file the exporter cannot read.`,
    );
  });
});

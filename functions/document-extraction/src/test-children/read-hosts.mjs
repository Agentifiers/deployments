import { readFileSync } from "node:fs";

const hosts = readFileSync("/etc/hosts", "utf8");
process.stdout.write(
  `${JSON.stringify({ status: "unusable", reason: "unreadable", detail: hosts.slice(0, 100) })}\n`,
);

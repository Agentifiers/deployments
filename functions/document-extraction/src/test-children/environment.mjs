const text = JSON.stringify(Object.keys(process.env));
const verdict = {
  status: "text",
  mediaType: "text/plain",
  truncated: false,
  facts: { kind: "text", encoding: "utf-8", lines: 1 },
};
process.stdout.write(`${JSON.stringify(verdict)}\n${text}`);

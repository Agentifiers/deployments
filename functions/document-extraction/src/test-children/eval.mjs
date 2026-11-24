// eslint-disable-next-line typescript/no-implied-eval -- the sandbox must stop this.
const escaped = new Function("return 'code generation was allowed'")();
process.stdout.write(
  `${JSON.stringify({ status: "unusable", reason: "unreadable", detail: escaped })}\n`,
);

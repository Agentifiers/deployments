function versionOf(binary: string) {
  try {
    const result = Bun.spawnSync([binary, "--version"], { stderr: "ignore" });
    return result.success ? result.stdout.toString().trim() : "unusable";
  } catch {
    return "missing";
  }
}

/** The Node major of the function's Lambda runtime (`nodejs26.x`). */
const LAMBDA_NODE_MAJOR = 26;

export function lambdaNodeBinary() {
  const binary = Bun.which(process.env.DOCUMENT_EXTRACTION_NODE ?? "node") ?? "node";
  const version = versionOf(binary);
  const [major = 0] = version.replace(/^v/u, "").split(".").map(Number);
  if (major < LAMBDA_NODE_MAJOR) {
    throw new Error(
      `The document extraction tests need Node ${LAMBDA_NODE_MAJOR} or newer (Lambda runs nodejs${LAMBDA_NODE_MAJOR}.x); ${binary} is ${version}. Set DOCUMENT_EXTRACTION_NODE to such a binary.`,
    );
  }
  return binary;
}

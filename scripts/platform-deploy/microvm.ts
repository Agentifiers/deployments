import type { Ulid } from "@deployments-ai/db";
import {
  createLambdaMicrovmProvider,
  type SandboxLease,
} from "../../packages/sandbox-hosts/src/index.ts";
import {
  type MicrovmImageVariant,
  microvmImageCapacity,
  resolveLambdaMicrovmImage,
} from "../lambda-microvm-image.ts";
import { type Environment, log, repositoryRoot } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;

export interface MicrovmImageVariables {
  readonly lambda_microvm_image_capacity?: { readonly memory_mib: number; readonly vcpu: number };
  readonly lambda_microvm_image_identifier: string;
  readonly lambda_microvm_image_version: string;
}

/** Carries the currently deployed MicroVM image into prerequisite plans before a new one is published. */
export function currentMicrovmImageVariables(
  outputs: TerraformOutputs,
): MicrovmImageVariables | undefined {
  const current = outputs.sandbox_lambda_microvm_runtime_configuration;
  if (current === null || typeof current !== "object") return undefined;
  const identifier: unknown = Reflect.get(
    current,
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_IDENTIFIER",
  );
  const version: unknown = Reflect.get(current, "DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_VERSION");
  return typeof identifier === "string" && identifier && typeof version === "string" && version
    ? { lambda_microvm_image_identifier: identifier, lambda_microvm_image_version: version }
    : undefined;
}

export async function publishMicrovmImage(input: {
  readonly environment: Environment;
  readonly region: string;
  readonly variant: MicrovmImageVariant;
}): Promise<MicrovmImageVariables> {
  log(`publishing the ${input.variant} Lambda MicroVM image`);
  const image = await resolveLambdaMicrovmImage({
    env: { ...input.environment },
    publish: true,
    region: input.region,
    root: repositoryRoot,
    variant: input.variant,
  });
  if (!image.imageArn || !image.imageVersion) {
    throw new Error("Lambda MicroVM image publication returned no image identifier or version.");
  }
  const capacity = microvmImageCapacity(input.variant);
  return {
    lambda_microvm_image_capacity: { memory_mib: capacity.memoryMiB, vcpu: capacity.vcpu },
    lambda_microvm_image_identifier: image.imageArn,
    lambda_microvm_image_version: image.imageVersion,
  };
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  const bytes = await new Response(stream).bytes();
  if (bytes.byteLength > 64 * 1024) throw new Error("Sandbox verification download was too large.");
  return new TextDecoder().decode(bytes);
}

/** Live-verifies exec, network isolation, file round-trip, checkpoint, resume, and destroy. */
export async function verifyLambdaMicrovmRuntime(
  input: MicrovmImageVariables & { readonly region: string },
) {
  log("verifying Lambda MicroVM sandbox lifecycle");
  const provider = createLambdaMicrovmProvider({
    ...(input.lambda_microvm_image_capacity
      ? {
          imageMemoryMiB: input.lambda_microvm_image_capacity.memory_mib,
          imageVcpu: input.lambda_microvm_image_capacity.vcpu,
        }
      : {}),
    imageIdentifier: input.lambda_microvm_image_identifier,
    imageVersion: input.lambda_microvm_image_version,
    maximumDurationInSeconds: 600,
    region: input.region,
  });
  let lease: SandboxLease | undefined;
  try {
    lease = await provider.create({
      environmentId: ENVIRONMENT_ID,
      executionTargetId: DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      isolationMode: "run-ephemeral",
      minMemoryMiB: 2_048,
      minVcpu: 1,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });
    const initial = await provider.exec({
      command: ["sh", "-lc", "printf sandbox-ready"],
      lease,
      timeoutMs: 10_000,
    });
    if (!("exitCode" in initial) || initial.exitCode !== 0 || initial.stdout !== "sandbox-ready") {
      throw new Error("Lambda MicroVM exec verification failed.");
    }

    // Hosted code with `network: "none"` depends on this: the command sees only its own loopback.
    const isolated = await provider.exec({
      command: [
        "python3",
        "-c",
        "import pathlib; lines = pathlib.Path('/proc/self/net/dev').read_text().splitlines()[2:]; print(' '.join(sorted(line.split(':', 1)[0].strip() for line in lines)))",
      ],
      lease,
      network: "none",
      timeoutMs: 10_000,
    });
    if (!("exitCode" in isolated) || isolated.exitCode !== 0 || isolated.stdout !== "lo\n") {
      throw new Error("Lambda MicroVM network isolation verification failed.");
    }

    const content = new TextEncoder().encode("sandbox-file-roundtrip");
    await provider.upload({ content, lease, path: "/tmp/deployments-ai-verification.txt" });
    const downloaded = await readStream(
      await provider.download({ lease, path: "/tmp/deployments-ai-verification.txt" }),
    );
    if (downloaded !== "sandbox-file-roundtrip") {
      throw new Error("Lambda MicroVM file round-trip verification failed.");
    }

    const checkpoint = await provider.checkpoint({ lease });
    lease = await provider.resume({
      lease: { ...lease, checkpointRef: checkpoint.checkpointRef, status: "suspended" },
    });
    const resumed = await provider.exec({
      command: ["sh", "-lc", "test -f /tmp/deployments-ai-verification.txt"],
      lease,
      timeoutMs: 10_000,
    });
    if (!("exitCode" in resumed) || resumed.exitCode !== 0) {
      throw new Error("Lambda MicroVM resume verification failed.");
    }
  } finally {
    if (lease) await provider.destroy({ lease });
  }
  log("Lambda MicroVM runtime verification passed.");
}

import "@tanstack/react-start/server-only";

/** Per-item API requests in flight at once; the dev API Gateway throttles larger bursts. */
export const FAN_OUT_CONCURRENCY = 4;

/**
 * Runs `task` over `inputs` with at most `concurrency` in flight, keeping input order. Callers
 * running several fan-outs at once split `FAN_OUT_CONCURRENCY` between them.
 */
export async function fanOut<Input, Output>(
  inputs: readonly Input[],
  task: (input: Input) => Promise<Output>,
  concurrency = FAN_OUT_CONCURRENCY,
): Promise<Output[]> {
  const results: Output[] = Array.from({ length: inputs.length });
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < inputs.length; index = next++) {
      results[index] = await task(inputs[index] as Input);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  return results;
}

import { AwsNativeMemoryError } from "./aws-native-contracts.ts";

export function awsNativeFailure(operation: string, cause: unknown) {
  return cause instanceof AwsNativeMemoryError
    ? cause
    : new AwsNativeMemoryError({
        cause,
        message: `AWS-native memory ${operation} failed.`,
        operation,
      });
}

export async function awsNativeRequest<Result>(
  operation: string,
  request: () => Promise<Result>,
): Promise<Result> {
  try {
    return await request();
  } catch (cause) {
    throw awsNativeFailure(operation, cause);
  }
}

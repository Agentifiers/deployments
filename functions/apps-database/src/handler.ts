import { AppDatabaseError, type AppDatabaseControl } from "@deployments-ai/app-database";
import {
  AppsDatabaseRequest,
  type AppsDatabaseErrorCode,
  type AppsDatabaseFailure,
  type AppsDatabaseValue,
} from "@deployments-ai/app-database/protocol";
import { Schema } from "effect";

export interface AppsDatabaseHandlerDependencies {
  readonly bucket: string;
  /** Opened per invocation: a frozen Lambda would otherwise wake with dead pooled sockets. */
  readonly openControl: () => AppDatabaseControl;
  readonly logError: (entry: Readonly<Record<string, unknown>>) => void;
}

const decodeRequest = Schema.decodeUnknownSync(AppsDatabaseRequest);

function failure(
  code: AppsDatabaseErrorCode,
  message: string,
  statement?: string,
): AppsDatabaseFailure {
  return {
    error: statement === undefined ? { code, message } : { code, message, statement },
    ok: false,
  };
}

function dispatch(
  control: AppDatabaseControl,
  bucket: string,
  request: AppsDatabaseRequest,
): Promise<AppsDatabaseValue> {
  switch (request.op) {
    case "provision":
      return control.provision({ appId: request.appId, slug: request.slug });
    case "migrate":
      return control.migrate({
        appId: request.appId,
        description: request.description,
        idempotencyKey: request.idempotencyKey,
        sql: request.sql,
      });
    case "query":
      return control.query({ appId: request.appId, maxRows: request.maxRows, sql: request.sql });
    case "describe":
      return control.describe(request.appId);
    case "export":
      return control.exportTables({ appId: request.appId, bucket, exportId: request.exportId });
    case "erase":
      return control.erase({ appId: request.appId, bucket, slug: request.slug });
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

export type AppsDatabaseHandler = (
  event: unknown,
) => Promise<{ readonly ok: true; readonly value: AppsDatabaseValue } | AppsDatabaseFailure>;

export function createAppsDatabaseHandler(
  dependencies: AppsDatabaseHandlerDependencies,
): AppsDatabaseHandler {
  return async (event) => {
    let request: AppsDatabaseRequest;
    try {
      request = decodeRequest(event);
    } catch (error) {
      return failure("invalid_request", error instanceof Error ? error.message : String(error));
    }
    const control = dependencies.openControl();
    try {
      return { ok: true, value: await dispatch(control, dependencies.bucket, request) };
    } catch (error) {
      if (error instanceof AppDatabaseError) {
        return failure(error.code, error.message, error.statement);
      }
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logError({ appId: request.appId, message, op: request.op });
      return failure("internal_error", message);
    } finally {
      await control.close();
    }
  };
}

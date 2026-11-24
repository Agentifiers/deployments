import { describe, expect, spyOn, test } from "bun:test";
import type { GetParameterCommand, GetParameterCommandOutput } from "@aws-sdk/client-ssm";
import type { DynamoDatabaseService } from "@deployments-ai/db";
import { TENANT_LIMIT_DEFAULTS_ENV } from "@deployments-ai/tenant-limits";
import {
  loadSystemOperatorConfiguration,
  SYSTEM_OPERATOR_CONFIGURATION_PARAMETER_ENV,
  type SystemOperatorConfiguration,
  type SystemOperatorParameterStore,
} from "./configuration.ts";
import { makeSystemOperatorFetch } from "./runtime.ts";

const PARAMETER_ARN = "arn:aws:ssm:us-east-2:123456789012:parameter/api/system-operator";
const TENANT_LIMIT_DEFAULTS_JSON = JSON.stringify({
  active_sandboxes: 8,
  api_request_burst: 40,
  api_requests_per_second: 20,
  concurrent_runs: 8,
});
const INVALID = {
  code: "system_operator_misconfigured",
  detail: expect.stringMatching(
    new RegExp(`^System operator configuration ${PARAMETER_ARN} is invalid: \\S`, "u"),
  ),
};

const OPENROUTER_ONLY: SystemOperatorConfiguration = {
  alarmNamePrefix: "",
  bedrockRegion: null,
  ecsServices: [["model-runtime", "platform", "bifrost"]],
  modelProviderSecrets: {
    openrouter: "arn:aws:ssm:us-east-2:123456789012:parameter/models/openrouter-api-key",
  },
  observability: null,
};

function fakeParameterStore(...replies: ReadonlyArray<string | Error>) {
  const names: Array<string | undefined> = [];
  return {
    names,
    parameterStore: {
      async send(command: GetParameterCommand): Promise<GetParameterCommandOutput> {
        names.push(command.input.Name);
        const reply = replies[Math.min(names.length, replies.length) - 1];
        if (reply instanceof Error) throw reply;
        return { $metadata: {}, Parameter: { Value: reply } };
      },
    },
  };
}

function componentsRoute(parameterStore: SystemOperatorParameterStore) {
  const handler = makeSystemOperatorFetch({
    authenticate: async () => ({
      authentication: "tenant-jwt",
      platformRole: "administrator",
      principalId: "01J000000000000000000000P1",
      scopes: [],
    }),
    database: {} as DynamoDatabaseService,
    environment: {
      [SYSTEM_OPERATOR_CONFIGURATION_PARAMETER_ENV]: PARAMETER_ARN,
      [TENANT_LIMIT_DEFAULTS_ENV]: TENANT_LIMIT_DEFAULTS_JSON,
    },
    parameterStore,
  });
  return async () => {
    const response = await handler(new Request("https://api.example/v1/system/components"));
    return { body: await response?.json(), status: response?.status };
  };
}

describe("system operator configuration", () => {
  test("reads an install that wires only some model providers from the OpenTofu parameter", async () => {
    const store = fakeParameterStore(JSON.stringify(OPENROUTER_ONLY));
    expect(
      await loadSystemOperatorConfiguration(
        { [SYSTEM_OPERATOR_CONFIGURATION_PARAMETER_ENV]: ` ${PARAMETER_ARN} ` },
        store.parameterStore,
      ),
    ).toEqual({ configuration: OPENROUTER_ONLY, kind: "configured" });
    expect(store.names).toEqual([PARAMETER_ARN]);
  });

  test("an install without the parameter is unconfigured and reads nothing", async () => {
    const store = fakeParameterStore(JSON.stringify(OPENROUTER_ONLY));
    expect(await loadSystemOperatorConfiguration({}, store.parameterStore)).toEqual({
      kind: "unconfigured",
    });
    expect(store.names).toEqual([]);
  });

  test("an invalid document disables only the operator routes and is read once per cold start", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = fakeParameterStore(
        JSON.stringify({ ...OPENROUTER_ONLY, modelProviderSecrets: { openrouter: "not-an-arn" } }),
      );
      const components = componentsRoute(store.parameterStore);
      const first = await components();
      const second = await components();
      expect(first.status).toBe(503);
      expect(first.body).toMatchObject(INVALID);
      expect(second.status).toBe(503);
      expect(second.body).toMatchObject(INVALID);
      expect(store.names).toEqual([PARAMETER_ARN]);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("a failed parameter read answers 503 and retries on the next request", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = fakeParameterStore(new Error("Rate exceeded"), "{");
      const components = componentsRoute(store.parameterStore);
      const first = await components();
      const second = await components();
      expect(first.status).toBe(503);
      expect(first.body).toMatchObject({
        code: "system_operator_misconfigured",
        detail: `System operator configuration ${PARAMETER_ARN} could not be read: Rate exceeded`,
      });
      expect(second.status).toBe(503);
      expect(second.body).toMatchObject(INVALID);
      expect(store.names).toEqual([PARAMETER_ARN, PARAMETER_ARN]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

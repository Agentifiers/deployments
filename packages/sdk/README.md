# `@agentifiers/deployments-sdk`

A TypeScript client for the public API of the Deployments agent platform. It is
generated from the platform's OpenAPI document and exports one async function
per API operation, such as `listAgentDefinitions` or `sendEmail`, with typed
path parameters, query parameters, headers, request body, and response.

## Requirements

- Node.js 26 or later. The package declares `"node": ">=26"` in `engines`.
- ES modules. The package is ESM only, so load it with `import`.
- The API origin of a Deployments install, such as `https://api.example.com`,
  and a credential: a service-account API key or a tenant JWT.

## Install

The current release is a prerelease on the `next` dist-tag:

```sh
npm install @agentifiers/deployments-sdk@next
```

## Create a client and make a call

Create one client with the API origin and a credential, then pass it to every
call:

```ts
import {
  createClient,
  createConfig,
  getHealth,
  listAgentDefinitions,
} from "@agentifiers/deployments-sdk";

const client = createClient(
  createConfig({
    baseUrl: "https://api.example.com",
    headers: { authorization: `Bearer ${process.env.DEPLOYMENTS_API_KEY}` },
  }),
);

const health = await getHealth({ client });
console.log(health.data?.status);

const { data, error, response } = await listAgentDefinitions({
  client,
  headers: { "x-deployments-environment": "<environment-id>" },
  query: { limit: 20 },
});

if (error) {
  console.error(response?.status, error);
} else {
  for (const definition of data.items) console.log(definition.id, definition.name);
}
```

Each function returns `data` on success or `error` on failure, plus the
`request` and `response`. It does not throw on HTTP errors unless you pass
`throwOnError: true`.

## The client protects your credential

- `baseUrl` must be an origin with no path, query, or fragment.
- The origin must use HTTPS. Plain HTTP works only for loopback hosts such as
  `localhost` and `127.0.0.1`.
- The URL must not contain a user name or password.
- Every request must go to the client's configured origin. A request that
  carries an `authorization`, `cookie`, or `proxy-authorization` header fails
  if the client has no configured origin.
- The client does not follow redirects.

`createClient` throws a `TypeError` when `baseUrl` breaks a rule.
`validatePlatformBaseUrl(url)` runs the same check ahead of time. Create one
client per credential and origin instead of changing the exported default
`client`, which has no base URL.

## Exports

| Export                    | What it is                                                                   |
| ------------------------- | ---------------------------------------------------------------------------- |
| Operation functions       | One function per public API operation.                                       |
| `createClient`            | Creates a client and checks its base URL.                                    |
| `createConfig`            | Builds a client configuration, such as `baseUrl`, `headers`, and `fetch`.    |
| `client`                  | The shared default client. It has no base URL.                               |
| `validatePlatformBaseUrl` | Checks that a URL is a valid API origin.                                     |
| `Client`                  | The TypeScript type of a client.                                             |
| `contractMetadata`        | The API version, operation count, and SHA-256 hashes of the source contract. |

`@agentifiers/deployments-sdk/contract` exports the same contract metadata as JSON.

## Documentation

- [SDK overview](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/sdk/index.mdx)
- [Authentication](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/sdk/authentication.mdx)
- [Making requests](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/sdk/making-requests.mdx)
- [Error handling](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/sdk/errors.mdx)
- [Streaming run output](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/sdk/streaming.mdx)
- [Verifying webhooks](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/sdk/webhook-verification.mdx)

## License

MIT. See [LICENSE](LICENSE). The generated client runtime comes from
`@hey-api/openapi-ts` templates; [NOTICE](NOTICE) reproduces their MIT license.

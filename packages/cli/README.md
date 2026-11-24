# `@agentifiers/deployments-cli`

The `deployments` command-line interface for the Deployments agent platform. It
has one command for every public API operation, plus commands to sign in, store
your organization, project, and environment context, chat with an agent, and
preview a local agent manifest. Use it at a terminal or in scripts and CI jobs.

## Requirements

- [Bun](https://bun.sh) 1.3.14 or later. The CLI is a Bun program and does not
  run on Node.js. The package declares `"bun": ">=1.3.14"` in `engines`.
- The API origin of a Deployments install, such as `https://api.example.com`.

## Install

The current release is a prerelease on the `next` dist-tag:

```sh
npm i -g @agentifiers/deployments-cli@next
deployments --version
```

`bun add --global @agentifiers/deployments-cli@next` works too.

## Configure

Point the CLI at your install's API origin. The origin must use HTTPS and have
no path. Plain HTTP works only for loopback hosts such as `localhost`.

```sh
export DEPLOYMENTS_API_URL=https://api.example.com
deployments health
```

`deployments health` needs no credentials.

Sign in. In an interactive terminal, `auth login` starts a browser device flow.
Scripts and CI jobs use a service-account API key from a file or the
`DEPLOYMENTS_API_KEY` environment variable, which keeps the key out of process
arguments and shell history:

```sh
deployments auth login
deployments auth login --api-key-file ~/.config/deployments/api-key
deployments whoami
```

Store the context most commands need:

```sh
deployments context set --org "$ORG_ID" --project "$PROJECT_ID" --env "$ENV_ID"
deployments context show
```

Each setting resolves from a command flag first, then a `DEPLOYMENTS_*`
environment variable, then the active profile in the config file:

| Setting      | Flag                 | Environment variable                         |
| ------------ | -------------------- | -------------------------------------------- |
| Profile      | `--profile`          | `DEPLOYMENTS_PROFILE`                        |
| API origin   | `--api-url`          | `DEPLOYMENTS_API_URL`                        |
| Credential   | `--api-key`          | `DEPLOYMENTS_API_KEY`                        |
| Organization | `--org`              | `DEPLOYMENTS_ORG`                            |
| Project      | `--project`          | `DEPLOYMENTS_PROJECT`                        |
| Environment  | `--env`              | `DEPLOYMENTS_ENVIRONMENT`                    |
| Workspace    | `--workspace`        | `DEPLOYMENTS_WORKSPACE`                      |
| Mode         | `--mock` or `--live` | `DEPLOYMENTS_MOCK=1` or `DEPLOYMENTS_LIVE=1` |

Profiles live in `~/.config/deployments/config.json`, or under
`$XDG_CONFIG_HOME` or `$DEPLOYMENTS_CONFIG_DIR` when set. The CLI writes the
file with mode `0600`.

## Use

Resource commands name a resource, then an action, then an ID when the action
targets one resource:

```sh
deployments agent list
deployments agent show "$AGENT_DEFINITION_ID"
deployments deployment list --json
deployments chat --agent "$AGENT_DEPLOYMENT_ID" --message "Summarize the rollout"
```

Every command prints its options with `--help`. `deployments catalog` lists
every command, and `deployments catalog --json` prints the list as JSON.

To learn the command shapes without an API or credentials, add `--mock`. Mock
mode returns fixed sample data and prints a `MOCK` banner. Live mode is the
default.

```sh
deployments project list --mock
```

Running `deployments` with no arguments in an interactive terminal opens a menu
of common tasks. In scripts, always name a command.

## Scripting

- `--json` writes only JSON to stdout. Streaming commands such as `run tail`
  write one JSON object per line.
- Errors go to stderr as one line that starts with `Error:`.
- `--quiet` prints nothing on success.
- Secret fields are replaced with `[REDACTED]`, JSON included. `--reveal`
  prints them.
- Commands that create a resource or cause a side effect send an idempotency
  key. Pass the same `--idempotency-key` on every retry.
- Destructive live commands need `--yes` outside an interactive terminal or
  with `--json`.
- `--no-color` or `NO_COLOR=1` turns off ANSI color.

Exit codes:

| Code  | Meaning                       |
| ----- | ----------------------------- |
| `0`   | Success                       |
| `1`   | Unexpected failure            |
| `2`   | Usage error                   |
| `3`   | Authentication failure        |
| `4`   | Authorization failure         |
| `5`   | Not found                     |
| `6`   | Conflict                      |
| `7`   | Validation or missing context |
| `8`   | Service unavailable           |
| `130` | Canceled                      |

## Documentation

- [CLI overview](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/cli/index.mdx)
- [Signing in](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/cli/authentication.mdx)
- [Configuration and context](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/cli/configuration.mdx)
- [Output, scripting, and exit codes](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/cli/output-and-scripting.mdx)
- [Local preview loop](https://github.com/Agentifiers/deployments/blob/main/apps/docs/content/docs/cli/preview-loop.mdx)

## License

MIT. See [LICENSE](LICENSE). The package bundles third-party software whose
licenses are reproduced in [NOTICE](NOTICE).

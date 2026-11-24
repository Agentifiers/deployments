# `@deployments-ai/app-database`

Postgres access for agent-built apps. The `apps-database` Lambda uses
`createAppDatabaseControl` to provision, migrate, query, describe, export, and erase app
databases. The app gateway uses `createAppApiGateway` to call app functions. The
`/protocol` subpath holds the Lambda request and response schemas and has no Postgres
dependency.

## Postgres layout

Each app gets one database, `app_<id>`, created from the `app_template` database that
`runBootstrap` seals with `citext`, `pg_trgm`, and `pgcrypto`. The database has four
schemas:

| Schema     | Owner                  | Holds                                                                  |
| ---------- | ---------------------- | ---------------------------------------------------------------------- |
| `public`   | `app_<id>_owner`       | Tables, views, sequences, and helper functions.                        |
| `api`      | `app_<id>_owner`       | Functions members call, and views.                                     |
| `visitor`  | `app_<id>_owner`       | Functions that visitors to a public app call. Nothing else.            |
| `platform` | `platform_provisioner` | `platform.migrations`, the migration ledger. App SQL cannot change it. |

## Roles and credentials

Every app has four login roles. Each logs in with an IAM token and may connect only to its
own database.

| Role               | Connects from      | Connection limit | Privileges                                                                                                                                                                                                     |
| ------------------ | ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_<id>_owner`   | Lambda             | 8                | Owns `public`, `api`, and `visitor`. Runs migrations, `describe`, and `export`.                                                                                                                                |
| `app_<id>_editor`  | Gateway            | 32               | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on `public` tables. `USAGE` on `public`, `api`, `visitor`. `EXECUTE` on functions in all three.                                                                         |
| `app_<id>_viewer`  | Gateway and Lambda | 40               | `SELECT` on `public` tables. `USAGE` on `public`, `api`, `visitor`. `EXECUTE` on functions in all three. `app.query` runs as this role.                                                                        |
| `app_<id>_visitor` | Gateway            | 16               | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on `public` tables and `USAGE`, `SELECT` on their sequences. `USAGE` on `public`, `visitor`, `platform`. `EXECUTE` only on functions in `visitor`. No `USAGE` on `api`. |

All four roles may read `platform.migrations.id`, which versions the function catalog.
Connection limits come from `MAX_GATEWAY_TASKS_DURING_DEPLOY` times the role's pool size
in `DEFAULT_LIMITS.maxConnectionsPerPool`, times two logins per session (one for a
terminating session), plus eight Lambda logins for the owner and viewer roles.

## Provisioning

`provision` runs its steps in order and every step is idempotent, so a retry after a
crash at any point converges. It creates the roles and re-applies their connection
limits, grants `rds_iam`, creates the database with only the app roles allowed to
connect, creates the schemas, grants the privileges above, checks the result, and
publishes the slug.

The visitor role grants cover tables that exist before the grant as well as tables
created later. `provision` grants `ON ALL TABLES IN SCHEMA public` and
`ON ALL SEQUENCES IN SCHEMA public` and sets default privileges for new objects.
Running `provision` on a database from layout 1, which had no visitor role or schema,
upgrades it to the current layout, `VISITOR_DATABASE_LAYOUT` (2).

The `verify-catalog` step fails with `provision_incomplete` when the database ACL, the
`rds_iam` members, or a schema owner differ from the layout. It also runs the visitor
rules from the migration check below, so it fails when the visitor role can use `api`,
can execute an app function outside `visitor`, or lacks its grants on a `public` table
or sequence. Extension functions stay executable by `PUBLIC`. `configure-schemas` takes
the migration lock, so a migration cannot create a table between the default-privilege
change and the `ON ALL TABLES` grant.

## Migrations

A migration runs as the owner in one transaction. The parser refuses role, privilege,
extension, and transaction statements, cursors, `DROP SCHEMA`, and `ALTER SCHEMA ...
RENAME`, and requires every function in `api` and `visitor` to be `LANGUAGE sql` with a
`BEGIN ATOMIC` body. After the SQL runs, the migration fires its deferred constraints, and
then a catalog check rolls the migration back when:

- `public`, `api`, or `platform` no longer exists, or `visitor` no longer exists once the
  visitor role does, which catches a drop or rename run from inside a function body;
- a function in `public`, `api`, or `visitor` is `SECURITY DEFINER`, sets `role` or
  `session_authorization`, or sets a call limit (`statement_timeout`, `transaction_timeout`,
  `idle_in_transaction_session_timeout`, or `client_connection_check_interval`), or a table
  forces row level security;
- a relation in `public`, `api`, or `visitor` has an owner other than the app owner;
- a function in `api` or `visitor` has the wrong shape, a name outside
  `[a-z_][a-z0-9_]*`, or an unnamed or `VARIADIC` argument;
- two functions in `api` and `visitor` share a name;
- `api` holds a relation other than a view or composite type, or `visitor` holds a
  relation, a type, or an operator;
- a view or rule in `public`, `api`, or `visitor` reads the `platform` schema, because it
  would run with the owner's privileges;
- the visitor role can execute an app function outside `visitor`, or cannot execute one
  inside it, which happens when `ALTER FUNCTION ... SET SCHEMA` moves a function;
- a function in `visitor` depends on a function, operator, relation, or type the visitor
  role cannot use, such as an app function in `public` or anything in `api`.

The dependency rule follows only the visitor function's own references. Column defaults,
checks, and policies on the tables it writes run as the visitor role too, so they must not
call app functions.

The check also runs on a layout-1 database. It skips the visitor-role rules until both the
visitor role and the visitor schema exist.

A deferred trigger that defers constraints again, or a hold cursor opened from a function
body, still runs at COMMIT, after the check, and can drop an app schema. Re-running
provision recreates a dropped `api` or `visitor` schema but not a dropped `public`, because
provision alters `public` instead of creating it and fails with
`schema "public" does not exist`.

## API calls

The gateway calls `callApiFunction` with the function name, the caller, `appIsPublic`, and,
for a visitor call, `deadlineMs`. Function names are unique across `api` and `visitor`, so
the name finds the function. The function's schema and volatility pick the role the call
runs as.

| Function                | App is public            | App is not public                             |
| ----------------------- | ------------------------ | --------------------------------------------- |
| `api`, not volatile     | Viewer role, read only   | Viewer role, read only                        |
| `api`, volatile         | Editor role, read write  | Editor role, read write. Viewers are refused. |
| `visitor`, not volatile | Visitor role, read only  | Viewer role, read only                        |
| `visitor`, volatile     | Visitor role, read write | Editor role, read write. Viewers are refused. |

A visitor caller may call only `visitor` functions of a public app. Every other visitor
call fails with `visitor_not_allowed`, the same for an unknown name and an `api` name.

Every call sets `app.principal_id` and `app.principal_email` for the transaction. They
hold the member's id and email, or empty strings for a visitor caller.

## Deadlines and waits

`deadlineMs` bounds the whole call below `apiDeadlineMs`. The wait for a connection gets the
smaller of `connectionWaitMs` and the time left, and the statement timeout gets the time
left. The wait covers a pooled connection and a new one alike. A pooled connection that
stays busy answers `connections_exhausted`. A new connection that has not finished
connecting answers `database_unavailable`, and the pool releases it when it arrives.
With a `resumeWaitMs`, a new connection instead waits up to the rest of that window, since a
resuming Aurora cluster holds the login until it is up, and the call's deadline starts over
once the connection is in hand.

`graceMs` (2 s) bounds each statement the package sends outside the call's own deadline:
`pg_backend_pid()` on a new connection, `DISCARD ALL` when a connection goes back to the
pool, and the terminator's `pg_terminate_backend`. A transaction still running `graceMs`
after its deadline is terminated from a second connection of the same role, which has the
10 s connect timeout. When that terminate returns, the session waits up to `graceMs` for the
server to close the call's connection, so the answer to a COMMIT already sent arrives first.
Then it closes the socket itself. Every transaction sets `client_connection_check_interval`
to 1 s, so a backend that traps cancels ends about a second after its socket closes, even
when the terminator could not log in. That backstop holds unless app code changes the
setting inside a function body with `SET` or `set_config`, which the catalog check cannot
see. A function's own `SET` clause for it is refused.

A call answers `outcome_unknown`, not `deadline_exceeded`, when it sent COMMIT and the
database's answer did not arrive. The transaction may have committed, so a retry may apply
its changes twice.

## Error codes

| Code                       | Meaning                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `function_not_found`       | A member called a name that is in neither `api` nor `visitor`.             |
| `function_not_allowed`     | A viewer called a volatile function that runs as the editor role.          |
| `visitor_not_allowed`      | A visitor called anything other than a `visitor` function of a public app. |
| `invalid_arguments`        | The arguments do not match the function's named parameters.                |
| `result_too_large`         | The JSON result is larger than `apiResultMaxBytes`.                        |
| `deadline_exceeded`        | The call ran longer than its deadline and rolled back.                     |
| `outcome_unknown`          | The call sent COMMIT and got no answer, so it may have committed.          |
| `connections_exhausted`    | Every pooled connection stayed busy for the connection wait.               |
| `database_unavailable`     | The database did not answer or refused the connection.                     |
| `provision_incomplete`     | `provision` found the database out of layout.                              |
| `sql_rejected`             | The parser or the catalog check refused a migration or query.              |
| `postgres_error`           | Postgres refused the statement.                                            |
| `idempotency_conflict`     | A migration reused an idempotency key with different SQL.                  |
| `key_value_store_conflict` | Publishing or removing the slug route conflicted; retry.                   |

## Limits

`DEFAULT_LIMITS` in `src/limits.ts` sets the defaults. Each process opens one pool per
app and role. A pool holds at most `maxConnectionsPerPool[role]` connections: 4 for the
owner, editor, and viewer roles and 2 for the visitor role. All pools in a process share
`maxConnectionsTotal` (64). An API call has a 5 s deadline, or the shorter `deadlineMs` its
caller passes, a 2 s lock timeout, 16 MB of `work_mem`, and a 1 MiB result.

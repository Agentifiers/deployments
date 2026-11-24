---
name: app-builder
description: Build a web app with the app.* tools, a Postgres API, and a Vite React UI in the sandbox, then release and promote it.
---

# Build an app

The app has a Postgres database whose `api` schema functions are the API, and a static React site that calls them at `/_platform/api/<name>`. Work in `/workspace/app`. Follow these steps in order. Public apps and multi-page sites are in `app-publication`.

## 1. Create

`app.create {name, slug}` returns `appId` and `url`. Use the slug you are given. Slugs are permanent, and the same slug returns the same app. On `database_unavailable`, retry up to twice before you report it.

## 2. Schema and API

Send tables and every function in one `app.migrate {appId, description, sql}`. A failed migration applies nothing; fix the SQL and resend all of it.

- Tables in `public`: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at timestamptz NOT NULL DEFAULT now()` for ordering, money as integer cents.
- API functions only in `api`, each `LANGUAGE sql` with a `BEGIN ATOMIC ... END` body, `STABLE` for reads and `VOLATILE` for writes. Name every argument. No overloads; to change a signature, `DROP FUNCTION` it first.
- A column beats a same-named argument, so `WHERE employee = employee` is always true. Qualify the argument with the function name: `WHERE e.employee = list_expenses.employee`.
- The UI gets `{rows: [...]}`: a scalar function (`RETURNS bigint`) gives `[value]`, a row function (`RETURNS expenses`, `RETURNS SETOF expenses`, `RETURNS TABLE (...)`) gives objects keyed by column. Return exactly the columns and order the brief asks for, and `ORDER BY` every list. Use `coalesce(sum(x), 0)` when an empty sum must be 0.
- Refuse a bad write with an error, never an empty or null result; an `UPDATE ... WHERE status = 'pending'` that matches no row silently succeeds. Use `CHECK`, `UNIQUE`, a partial unique index (`CREATE UNIQUE INDEX ON loans (item_id) WHERE returned_at IS NULL`), a foreign key, or this helper, created once in your first migration: `CREATE FUNCTION public.refuse(message text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '%', message; END $$;`. In an `api` function, call it before the write, with a `WHERE` that names the bad state: `SELECT public.refuse('already decided') FROM expenses WHERE id = expense_id AND status <> 'pending';` then the `UPDATE`. A missing row is `SELECT public.refuse('not found') WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.sku = adjust_stock.sku);`. With only pgcrypto, citext, and pg_trgm installed (no btree_gist), refuse overlaps with `SELECT public.refuse('overlaps') WHERE EXISTS (... WHERE b.starts_at < ends_at AND starts_at < b.ends_at)`.
- The signed-in user is `current_setting('app.principal_id', true)`; store it in a column with that default. When rows belong to users, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and add a policy per command: `FOR SELECT USING (true)` when everyone may see totals, `FOR INSERT WITH CHECK (voter = current_setting('app.principal_id', true))`, `FOR DELETE USING (voter = ...)`. A command without a policy sees no rows.
- Not allowed: transaction control, DO blocks, GRANT or roles, CREATE EXTENSION, COPY, SECURITY DEFINER.

`app.query {appId, sql}` runs one read-only query to inspect data.

## 3. Client and template

`app.describe {appId}` returns `client`, a TypeScript file with one async function per app function. Write it verbatim to `src/platform-client.ts` and import from it: `await submit_expense({ employee, description, amount_cents })`. Set functions return arrays, others the single value or row. Errors throw `PlatformApiError`; show its `message`.

Write the template in one `code.execute` with heredocs:

`package.json`

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "dependencies": { "react": "^19.1.0", "react-dom": "^19.1.0" },
  "devDependencies": { "vite": "^6.3.0" }
}
```

`vite.config.ts`

```ts
import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: { assetsInlineLimit: 0 },
  esbuild: { jsx: "automatic" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/_platform": {
        target: process.env.APP_URL,
        changeOrigin: true,
        headers: { Authorization: `Bearer ${process.env.APP_DEV_TOKEN}` },
      },
    },
  },
});
```

`index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`

```tsx
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
createRoot(document.getElementById("root")!).render(<App />);
```

Then write `src/App.tsx` and `src/index.css`. One page, no router: the live site is served under `/_r/<release>/`. Label every input, show loading and error states, refresh lists after each write, and show money in dollars.

Put fonts and images in the build; pages cannot load them from other sites. For a custom font, install a package such as `@fontsource/inter` and import it in `src/main.tsx` so the build ships its WOFF2 files. Never inline, base64-encode, or generate a font, because the live site blocks `data:` fonts.

## 4. Long commands

Match every tool's input schema exactly: a call outside it is redone once, and a second in a row fails the run. Call `code.execute` with only `{language: "bash", code, timeoutMs}`: `timeoutMs` at most 50000, `code` at most 20 KiB. Write big files with `sandbox.files.write`, which takes only `{path, content}`; `content` is always a string, so stringify JSON. Start anything over 50 s detached with `setsid -f`, then rerun the poll until the `.done` file holds `0`:

```bash
cd /workspace/app && setsid -f sh -c 'npm install --no-audit --no-fund >/tmp/install.log 2>&1; echo $? >/tmp/install.done' </dev/null >/dev/null 2>&1
```

```bash
for i in $(seq 45); do [ -f /tmp/install.done ] && break; sleep 1; done; cat /tmp/install.done; tail -n 5 /tmp/install.log
```

## 5. Dev server and checks

`app.dev_token {appId}` returns `token` and `url`. Start Vite with them in the environment, never in a file:

```bash
cd /workspace/app && APP_URL='<url>' APP_DEV_TOKEN='<token>' setsid -f npx vite >/tmp/vite.log 2>&1 </dev/null
for i in $(seq 20); do curl -sf http://127.0.0.1:5173/ >/dev/null && break; sleep 1; done; tail -n 5 /tmp/vite.log
```

Exercise each function, refusals too, through the proxy: `curl -s -X POST http://127.0.0.1:5173/_platform/api/<name> -H 'content-type: application/json' -d '{"arg":"value"}'`. Then `browser.capture_screenshot {url: "http://127.0.0.1:5173/"}` (only `127.0.0.1` works) and fix what looks wrong. The token lasts 15 minutes; on a 401, mint another and restart Vite (`pkill -f vite` first). Rows you create while testing stay, so keep them few.

## 6. Release and promote

`npm run build` (`timeoutMs: 50000`) and `! grep -rlE 'data:(font|application)' dist`, which names any file with an inlined font. Then `app.release {appId, directory: "app/dist"}` and `app.promote {appId, releaseId}`. Finish only when the promote succeeds.

The first promote runs at once. After it the app is live: every `app.migrate` and `app.promote` waits for a human to approve, and the dev token can only read. Get the schema, API, and UI right before the first promote; afterwards batch changes into one migration and one promote.

A later turn keeps `/workspace` and the app but no processes. Call `app.create` with the same slug to get `appId` back, `app.describe` to see what the app has, and restart Vite before using it.

If an app tool keeps failing for a reason your SQL or code cannot fix, such as an app that stays `provisioning` or is `failed`, stop and report the error. Do not poll `app.list` in a loop.

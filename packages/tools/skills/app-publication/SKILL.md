---
name: app-publication
description: Open an app built with app-builder to the public or serve it as a multi-page static site, with visitor functions for forms such as a sign-up, app.set_publication audience and serving, and static-site pages. Pin it together with app-builder.
---

# Publish an app

This extends the `app-builder` steps. An app opens only to signed-in members until someone makes it public. `app.set_publication` sets who can open the app (`audience`) and how its files are served (`serving`).

## Visitor functions

Write these only when the brief says people who are not members use the app, such as a sign-up form on an event site. Once the app is public, anyone on the internet can call a `visitor` function. Visitors can call only `visitor` functions; `api` functions still need a signed-in member.

- Send them in the same `app.migrate` as the tables and `api` functions. Write each form as one `visitor` function: `CREATE FUNCTION visitor.sign_up(name text, email text) RETURNS void LANGUAGE sql VOLATILE BEGIN ATOMIC INSERT INTO signups (name, email) VALUES (sign_up.name, sign_up.email); END;`. The client from `app.describe` includes it, and the UI calls it like any other function, at `/_platform/api/sign_up`. One name per function across `api` and `visitor`.
- Validate input with constraints on the table, such as `NOT NULL`, `CHECK (length(name) BETWEEN 1 AND 200)`, and `CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')`. A bad call then fails with 422 `postgres_error` and a generic message that never names the constraint, so the page must state each rule (length, format, deadline) itself and check it before the call. To keep duplicates out without telling strangers who already signed up, add `UNIQUE (email)` and end the insert with `ON CONFLICT DO NOTHING`. Leave out the conflict target: `ON CONFLICT (email)` also needs a `SELECT` policy that admits the row, so every call fails on a table whose only policy admits inserts.
- A `visitor` function can use tables in `public` and other `visitor` functions, never `public.refuse` or any other function in `public` or `api`. Defaults, checks, and policies on the tables it writes must not call app functions either, or the visitor's write fails.
- Return nothing from a form. A `visitor` function that reads returns its rows to anyone, so return only what every visitor may see.
- A table with row-level security needs a policy that admits the visitor's write, such as `FOR INSERT WITH CHECK (true)`.
- A visitor who calls too often gets 429 `rate_limited`. Catch it and show a wait message, such as "Try again in N seconds", with N from the error's `retryAfter`.

## Public audience

When the brief says the app is for the public, call `app.set_publication {appId, audience: "public"}` after the first promote succeeds, before you finish. A human must approve it. Call `app.set_publication {appId, audience: "members"}` to close the app again; that runs at once.

## Multi-page static sites

Choose static-site serving when the brief asks for a site of several pages that people link to directly, such as an event site with a schedule page and a venue page. Keep the default single-page serving for one interactive app; then every path returns `index.html`. `app.release` does not set the serving mode. Call `app.set_publication {appId, serving: "static-site"}` before the first `app.promote`; it runs at once then, and once the app is live a human must approve the change.

- Write one HTML file per page. Plain HTML pages, written straight into the directory you release, can replace the React template. Put `index.html` at the root of the build. A page at `/schedule` is `schedule.html`, and a page at `/venue/` is `venue/index.html`. The other spelling of each path redirects to the one that exists.
- Add a `404.html` at the root if missing pages should show the site's own page. Without it, a missing page shows a plain platform page.
- Link between pages with relative URLs, such as `href="schedule.html"` or `href="../index.html"`. Never write `/_r/` paths. Give images, styles, scripts, and fonts relative URLs too; the platform points them at the release's files.
- SVG, PDF, XML, and XHTML files are never served, as pages or as images. Use PNG, JPEG, or WebP images, or put SVG markup inline in the page.
- A release holds at most 500 HTML pages.
- Pages can still call the app's functions at `/_platform/api/<name>`.

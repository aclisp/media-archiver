# How to Get a Weibo Cookie for the Archive Scripts

This project uses a `WEIBO_COOKIE` environment variable to authenticate Weibo API requests. The cookie is your logged-in browser session. Treat it like a password.

## Important Safety Rules

- Do not commit cookies to Git.
- Do not paste cookies into chat, issues, PRs, or logs.
- Do not store cookies in long-lived files unless you understand the risk.
- If you accidentally expose a cookie, log out of Weibo or invalidate the session.

## Get the Cookie from Chrome DevTools

1. Open Chrome and log in to Weibo.
2. Visit a Weibo page, for example:

   ```text
   https://weibo.com/1401527553/R4JwG0ktx
   ```

3. Open Chrome DevTools:

   ```text
   Cmd + Option + I
   ```

4. Go to the `Network` tab.
5. Reload the page.
6. In the network request list, click a Weibo API request, for example:

   ```text
   ajax/statuses/show?id=...
   ajax/statuses/mymblog?uid=...
   ```

7. Open the `Headers` panel for that request.
8. Find `Request Headers`.
9. Copy the full value of the `cookie` header.

   Copy only the value after `cookie:`, not the word `cookie:` itself.

## Use the Cookie

Run the user archive script with the cookie in the environment:

```bash
WEIBO_COOKIE='PASTE_COOKIE_VALUE_HERE' \
bun run src/weibo-archive-user.ts \
  --uid 1401527553 \
  --from 2026-06-01 \
  --to 2026-06-18
```

The cookie must be from a **logged-in** Weibo session (copy it while signed in to `weibo.com`); a visitor/guest cookie will not work. By default the script processes at most `50` posts per run (`--max-posts-per-run`); increase it if your date range contains more.

## Temporary Local File Option

If you prefer not to paste the cookie into every command, you can save it in a local file such as:

```text
WEIBO_COOKIE.txt
```

Then run a command that reads it into the environment:

```bash
export WEIBO_COOKIE="$(cat WEIBO_COOKIE.txt)"
bun run src/weibo-archive-user.ts \
  --uid 1401527553 \
  --from 2026-06-01 \
  --to 2026-06-18
```

Run this from the repo root so `src/weibo-archive-user.ts` resolves. Put the `export` on its own line: an inline `WEIBO_COOKIE="$(cat ...)"` before the command can place the full cookie value in your shell history and in the process environment (visible to other users on shared systems). Restrict the file and keep it untracked:

```bash
chmod 600 WEIBO_COOKIE.txt     # readable only by you
```

Make sure the file is not committed (it is already in `.gitignore`).

Check Git status before committing:

```bash
git status --short
```

## Cookie Lifetime

Weibo cookies can expire or be invalidated. A copied cookie may stop working when:

- the browser session expires;
- you log out;
- Weibo asks for verification;
- your IP/device/session changes enough to trigger risk checks;
- Weibo invalidates the session server-side.

If the script starts returning login pages, visitor-system HTML, `403`, `418`, or `429`, stop the crawl and refresh the cookie from Chrome DevTools.

## Recommended Practice

Use small date ranges and conservative request delays. The archive script is designed to be resumable, so it is better to run several small sessions than one aggressive crawl.

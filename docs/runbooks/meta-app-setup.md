# Meta app setup: Facebook Pages, Instagram and Threads

Loomcast publishes to a Facebook Page, the Instagram professional account linked to it, and a
Threads profile. All three go through one Meta developer app. This runbook is the owner's
checklist for that app (checkpoint **C7**), the server settings it produces, and how to test the
sign-in flows locally through a tunnel.

App IDs are not secret, but app secrets are. Secrets never go into this repository, a chat, an
issue or shell history; they go only into the server's env file. Commands below use placeholders
such as `<app-id>`.

> **Owner checkpoint C7.** The owner creates the app and records the values in step 8. The app
> stays in **Development mode**: only people with a role on the app can sign in, which is all
> Loomcast needs, so no App Review is required. The live check (connecting the real accounts on
> production) happens after go-live (G1).

## API versions this build targets

Checked against Meta's developer documentation on 2026-10-13.

| API | Host | Version | Notes |
|---|---|---|---|
| Graph API (Facebook Login, Pages, Instagram) | `https://graph.facebook.com` | `v26.0` (released 2026-07-29) | `META_GRAPH_VERSION`; Meta supports each version for about two years |
| Login dialog | `https://www.facebook.com/<version>/dialog/oauth` | same as the Graph API | |
| Threads API | `https://graph.threads.net` | `v1.0` | The token endpoints are unversioned |
| Threads authorization window | `https://threads.com/oauth/authorize` | | `threads.net` redirects there |

When Meta releases a new Graph API version, read its changelog, then raise `META_GRAPH_VERSION`
on the server and run `meta:check` again.

## Step 1: create the app

1. Open <https://developers.facebook.com/apps> with the Facebook account that manages the Page.
2. **Create app**. Choose the **Business** app type (in the use-case picker: *Other*, then
   *Business*), give it a name such as `Loomcast`, and connect it to the business portfolio that
   owns the Page if you have one.

## Step 2: add the use cases

In the app dashboard, **Use cases → Add use cases**, and add:

| Use case | What it gives Loomcast |
|---|---|
| Facebook Login for Business | Sign-in, listing the Pages you manage, and Page publishing |
| Instagram API with Facebook Login (content publishing and insights) | Publishing Reels and reading insights for the Instagram account linked to a Page |
| Access the Threads API | Sign-in, publishing and insights for your Threads profile |

## Step 3: accounts and roles

1. The Instagram account must be a **Business** or **Creator** account, linked to the Facebook
   Page (Page settings → Linked accounts → Instagram, or Instagram → Settings → Account type and
   tools). Without the link, the Page sign-in offers no Instagram account.
2. **App roles → Roles**: add every person who will connect accounts as an Administrator,
   Developer or Tester. In Development mode nobody else can sign in.
3. Leave the app in **Development** mode. Switching it to Live would require App Review.

## Step 4: Facebook Login for Business configuration

1. **Facebook Login for Business → Configurations → Create configuration**.
2. Name it `Loomcast publishing`. Choose **User access token** as the token type (Loomcast reads
   the Pages you manage with your sign-in and stores each Page's own token).
3. Select these permissions:
   - `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`,
     `business_management`
   - `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`
4. Save, and record the **Configuration ID**. It becomes `META_LOGIN_CONFIG_ID`.

## Step 5: redirect URIs

**Facebook Login for Business → Settings → Valid OAuth Redirect URIs**, add:

```text
https://loomcast.prabhavalabs.com/api/oauth/meta/callback
```

In the Threads use case (**Access the Threads API → Settings**), set the **Redirect Callback
URLs** to:

```text
https://loomcast.prabhavalabs.com/api/oauth/threads/callback
```

The same page asks for an **Uninstall Callback URL** and a **Delete Callback URL**; use the
privacy page of step 7 for both until Loomcast handles them.

For local testing, also add the tunnel URLs of the [local testing](#local-testing-through-a-tunnel)
section (`https://<tunnel-host>/api/oauth/meta/callback` and
`https://<tunnel-host>/api/oauth/threads/callback`), and remove them afterwards. The redirect URI
Loomcast sends must match a registered one exactly, including the scheme and the path.

## Step 6: Threads

1. **App roles → Roles → Threads testers**: add your Threads profile.
2. Accept the invite in the Threads app: **Settings → Account → Website permissions → Invites**.
3. In the Threads use case, make sure these permissions are added: `threads_basic`,
   `threads_content_publish` and `threads_manage_insights`.
4. Record the **Threads app ID** and **Threads app secret** (Threads use case → Settings, or
   App settings → Basic, which shows them separately from the Meta app ID and secret).

## Step 7: app settings

**App settings → Basic**:

- **Privacy Policy URL** and **User data deletion** (instructions URL): fill them in if the
  dashboard requires them. A page on the Loomcast site is enough for an app in Development mode.
- Record the **App ID** and the **App secret** (Show). They become `META_APP_ID` and
  `META_APP_SECRET`.

Under **App settings → Advanced → Security**, turning on **Require app secret** is recommended:
Loomcast signs every Graph API call with an `appsecret_proof`.

## Step 8: server settings

On the server, edit `/opt/loomcast/env/api.env` (owner root, mode 0600) and set:

```bash
META_APP_ID=<app-id>
META_APP_SECRET=<app-secret>
META_LOGIN_CONFIG_ID=<configuration-id>
META_GRAPH_VERSION=v26.0
THREADS_APP_ID=<threads-app-id>
THREADS_APP_SECRET=<threads-app-secret>
```

Leave `OAUTH_REDIRECT_BASE`, `META_GRAPH_BASE_URL` and `THREADS_GRAPH_BASE_URL` unset in
production: the redirect URIs then start with `APP_ORIGIN`, and the platform hosts are Meta's.
Each provider needs all of its values: the api refuses to start with only some of them.

Restart the api so it reads the file (redeploying the running tag does that), then check the
credentials:

```bash
cd /opt/loomcast/current   # or releases/<tag>
dc() { docker compose -p loomcast -f compose.prod.yml --env-file /opt/loomcast/env/compose.env "$@"; }
dc exec api node dist/cli/meta-check.mjs
```

`meta:check` asks Meta for an app access token with each app ID and secret, reads the app's own
record, and prints the redirect URIs to register. It prints no secret or token. Exit code 0 means
every configured provider passed; 1 means a check failed (the message says which); 2 is a usage
error. From a checkout with the values in the root `.env`, the same check is
`pnpm --filter @loomcast/api run meta:check`.

## Connecting the accounts

In Loomcast, open the workspace the accounts belong to, then
**Workspace settings → Channels → Connect**. After the sign-in, the connect page asks which
workspace the accounts join (it starts with the one you came from); an account already connected in
another workspace is refused with a message naming that workspace.

- **Facebook Page and Instagram** opens the Facebook dialog with the configuration of step 4.
  Choose the Page (and its business), allow every permission, and pick the Page and the Instagram
  account on the connect page. Accepting an Instagram account always connects its Page too,
  because the Page holds the token.
- **Threads** opens the Threads authorization window. Allow it, then accept the profile.

New channels are `active` and stay in **dry-run** until someone switches them off on purpose.
Every day the server checks each channel's token (`channel.verify`) and refreshes Threads tokens
that expire within 15 days (`channel.refresh_token`). A token the platform refuses sets the
channel to `needs_reauth` and raises an alert; reconnect it with the same steps. **Disconnect**
on a channel wipes its stored token.

Page tokens obtained through a long-lived sign-in do not expire on their own. They stop working
when the person who connected them loses their role on the Page, changes their password, or
removes the app's access in Facebook settings (Business integrations).

## Local testing through a tunnel

Meta only redirects to HTTPS URLs that are registered with the app, so local sign-ins go through
a `cloudflared` quick tunnel. A quick tunnel gets a random `https://<words>.trycloudflare.com`
host each time it starts; nothing is configured in the Cloudflare account.

1. Start the stack and the dev servers as usual ([local-development.md](../local-development.md)).
   The Vite dev server on port 5173 proxies `/api` to the api.
2. In another terminal, start the tunnel to the Vite dev server and note the host it prints:

   ```bash
   cloudflared tunnel --url http://localhost:5173
   ```

3. In the root `.env`, point the app at the tunnel and fill in the app values of step 8:

   ```bash
   APP_ORIGIN=https://<tunnel-host>
   OAUTH_REDIRECT_BASE=https://<tunnel-host>
   ```

   `OAUTH_REDIRECT_BASE` is the base of the redirect URIs Loomcast sends (it defaults to
   `APP_ORIGIN`). Then restart the dev servers, allowing the tunnel's host in Vite, which refuses
   requests for hosts it does not know:

   ```bash
   __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<tunnel-host> pnpm dev
   ```
4. Register `https://<tunnel-host>/api/oauth/meta/callback` and
   `https://<tunnel-host>/api/oauth/threads/callback` as in step 5.
5. Open `https://<tunnel-host>` (not `localhost`), sign in, and connect the accounts. The session
   cookie belongs to the host you signed in on, and the callback needs it.
6. Afterwards, stop the tunnel, remove its redirect URIs from the app, and restore `APP_ORIGIN`.

Keep `PUBLISHING_MODE=dry-run` locally: connected channels then only record what they would post.

For automated tests nothing reaches Meta: the api tests answer every Graph and Threads call with
synthetic responses, and E2E runs can point `META_GRAPH_BASE_URL` and `THREADS_GRAPH_BASE_URL` at
a fake server.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The connect page shows `not_configured` | The provider's values are missing on the server, or `LOOMCAST_ENCRYPTION_KEY` is not set |
| Facebook shows "URL blocked" or "redirect_uri mismatch" | The callback URL is not registered exactly (step 5), or `OAUTH_REDIRECT_BASE` differs from the registered host |
| `invalid_state` | The sign-in took longer than 10 minutes, was opened twice, or the callback arrived without the session (signed in on another host) |
| `no_accounts` | The account has no Page role, or did not select a Page in the dialog |
| The Page connects but no Instagram account is offered | The Instagram account is not a Business or Creator account linked to the Page (step 3) |
| Threads says the app is not available | The Threads tester invite was not accepted (step 6) |
| A channel turns `needs_reauth` | The token was revoked or expired; reconnect it |

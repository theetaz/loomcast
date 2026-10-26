# API clients

An API client lets another backend you run, such as a website or a newsletter tool, schedule posts on a workspace's Facebook Pages and Instagram accounts through Loomcast's REST API. You decide which channels each client may use and how far it may go on each; Loomcast does the publishing. API clients are managed per workspace in **Workspace settings → API clients**, which only the owner sees.

Use an API client for a server that posts on its own. To work with Loomcast from an assistant or an editor, create an access token instead (see [Settings](settings.md)).

## What a client can do

Each client belongs to the workspace it was created in, and can only be given that workspace's channels. The posts it creates appear in that workspace as content items, next to your studio's videos, with "From an API client" in their version history. For each channel you pick one level:

| Level | The client may |
|---|---|
| **No access** | Nothing. The client cannot see the channel at all |
| **Read** | See the channel and the status, links, errors and metrics of its posts |
| **Write** | Also schedule posts on it. Each post waits in **Approvals** until you approve it |
| **Publish** | Also approve its own posts. They are scheduled at once and go out at their time |

A post on several channels needs at least **Write** on all of them, and it is approved on your behalf only with **Publish** on all of them. A channel with **Requires approval** switched on keeps every post for you, whatever the client's level, and a channel in dry run only records what it would send. Approving, editing and rejecting a client's posts work as for any other post (see [Videos, review and approvals](videos-and-review.md)).

## Create a client

1. Open the workspace the backend should post for, then **Workspace settings → API clients**, and select **New client**.
2. In **Name**, name it after the backend that will use it, for example "Blog backend". Create one client per backend, so you can revoke one without breaking the others. A backend that posts for several brands needs a client in each of their workspaces.
3. In **Key expires**, keep **Never expires** or pick 30 days, 90 days or 1 year. An expired key stops working; create a new client then.
4. Under **Channels**, every channel of the workspace starts with **No access**. Set **Read**, **Write** or **Publish** on the channels the backend should use. Give **Publish** only to a backend you trust to post without your review.
5. Select **Create client**.
6. Select **Copy key** and store it in the backend's secret settings. This is the only time the key is shown; Loomcast keeps just enough to recognise it. If you lose it, revoke the client and create a new one.
7. Select **Done**.

The person who connects the backend needs the key and the API's address, `https://<your Loomcast address>/api/v1`. The full reference for developers is in the [machine API documentation](../api.md) and, for language models, at `/llms.txt` on your Loomcast address. **Connect a backend** on the same page shows a first request to try.

## The clients table

The table lists the open workspace's clients. Each row shows the client's **Name** with the start of its key, its **Channels** with their levels, when it was **Last used**, and its **Status**: **Active**, **Expired** or **Revoked**, with the expiry date of an active key that has one. Revoked clients stay listed for reference, without actions.

## Change a client's channels

Select the pencil icon on the client's row, change the name or the level of any channel, and select **Save changes**. The change applies to the client's next request: a channel set to **No access** disappears for it at once. Posts it already scheduled stay on the calendar; you can still move, approve or cancel them in Loomcast.

## Revoke a client

Select the bin icon on the client's row, then **Revoke client**. Its key stops working at once and cannot be restored. Posts it scheduled stay scheduled; cancel them in the calendar if they should not go out.

## Keep an eye on it

- Posts a client creates show in **Approvals** (with **Write**) and on the calendar like any other.
- Every request a client makes that changes something is recorded in the audit log under the client, and the changes it makes in your name are recorded too.
- If a client's posts look wrong, set its channels to **Read** or revoke it, then cancel its open posts in the calendar.

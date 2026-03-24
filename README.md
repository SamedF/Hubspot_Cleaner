# HubSpot Inbox Cleaner for meeting confirmations

This service sits next to a HubSpot private app and watches for `conversation.newMessage` webhooks. When a new incoming email looks like a calendar confirmation or invitation email, it can either:

- close the conversation thread safely, or
- archive the thread fully.

## What this app is for

This app is useful when your team gets a lot of booking or meeting-confirmation emails inside a HubSpot inbox and you do not want those threads cluttering the queue.

Typical examples:
- Calendly booking emails
- Google Calendar invitation updates
- Microsoft/Outlook invitation emails
- internal scheduling notifications that carry `.ics` files

## How it works

1. HubSpot sends a webhook when a new conversation message arrives.
2. Your service validates HubSpot's v3 webhook signature.
3. It fetches the exact message that triggered the webhook.
4. It checks whether the message is incoming.
5. It checks for `.ics` attachments and optional sender/subject/body regex rules.
6. If it matches, it closes or archives the thread.

## Important safety behavior

The default action in `.env.example` is:

- `ACTION=close`

That is safer than archive.

- `close` updates the thread status to `CLOSED`
- `archive` sends the thread to trash, and HubSpot says it will be permanently deleted after 30 days

## Why this version is safer than the original

This updated version adds:
- exact message fetch by `messageId`
- retry and backoff for transient HubSpot API failures
- duplicate webhook protection in memory
- safer default action (`close`)
- better `.ics` detection
- fallback to original message content when HubSpot truncates message text
- cleaner startup validation and shutdown handling

## Required HubSpot setup

Create a private app in HubSpot and configure both scopes and webhooks there.

### Scopes
Add at least:
- `conversations.read`
- `conversations.write`

### Webhook
In HubSpot:
1. Go to **Development > Legacy apps**
2. Open your private app
3. Open **Webhooks**
4. Set the target URL to:
   - `https://YOUR-DOMAIN/webhooks/hubspot`
5. Add and activate this subscription:
   - object type: **Conversations**
   - event: **conversation.newMessage**
6. Save / commit changes

## Environment variables

Copy `.env.example` to `.env`.

### Required
- `HUBSPOT_PRIVATE_APP_TOKEN`
- `HUBSPOT_APP_CLIENT_SECRET`

### Recommended first values
- `DRY_RUN=true`
- `ACTION=close`
- `REQUIRE_ICS_ATTACHMENT=true`
- `ONLY_IF_THREAD_OPEN=true`

### Optional filters
- `IGNORE_INBOX_IDS`
- `IGNORE_CHANNEL_IDS`
- `SENDER_ALLOWLIST_REGEX`
- `SUBJECT_ALLOWLIST_REGEX`
- `BODY_ALLOWLIST_REGEX`

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

## Production hosting

Any platform with a public HTTPS URL works, for example:
- Railway
- Render
- Fly.io
- AWS
- a VPS with Nginx in front

## Safe test flow

1. Start with `DRY_RUN=true`
2. Use one low-risk inbox first
3. Send a real meeting email with a `.ics` attachment to that inbox
4. Check logs
5. Once logs look correct, keep `ACTION=close` and switch only `DRY_RUN=false`
6. After you trust it, decide whether you really want `archive`

## Healthcheck

- `GET /health`

Returns JSON with app status, dry-run state, and current action.

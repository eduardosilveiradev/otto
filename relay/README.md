# relay — always-on Telegram front door (opt-in)

Off by default. Without it, a message sent while Otto's machine is asleep or Otto
is down just sits at Telegram until the poller comes back, and the user hears
nothing. With it, Telegram talks to a Cloudflare Worker instead:

```
Telegram ──webhook──▶ Worker (worker.ts) ──POST /telegram──▶ Otto (Tailscale Funnel → otto webhook listener)
                         │  no 2xx within 5s
                         ├─▶ queue the update (Durable Object, keyed by update_id)
                         └─▶ once per outage per chat: "otto's offline — got it, i'll answer when it's back"
Otto, at boot and every minute ──POST /drain──▶ Worker: queued updates, oldest first; acked after handling
```

- Only chats in `ALLOWED_CHATS` get any response; everything else gets a bare 200 and is dropped.
- Every push carries the whole queue in `update_id` order, and Otto ignores an
  `update_id` it has already handled, so a late ack never doubles a message.
- In Otto, pushed and drained updates run through grammY's `handleUpdate` —
  the exact handlers a polled update runs. Outbound sends still go straight to
  the Bot API.
- An outage ends when a push succeeds or a drain acks something; the next
  failure after that may notify again.

Limits: pairing a new chat needs polling mode (unknown chats never reach the
Otto). A button tapped while Otto was away still runs when it comes back, but
Telegram has long stopped waiting for the tap's answer, so its spinner just
times out.

## Deploy

Needs a Cloudflare account (the free plan covers it: SQLite-backed Durable
Objects are on the free tier) and Otto's webhook listener reachable through
Tailscale Funnel. Run from this directory.

1. Two random secrets — keep them in your password manager, not a file here:

   ```bash
   openssl rand -hex 32   # TELEGRAM_SECRET: Telegram -> Worker
   openssl rand -hex 32   # RELAY_SECRET:    Worker <-> Otto
   ```

2. Publish Otto's route. Otto must already have the webhook listener on
   (`webhook.token` set in `access.json`, default port 4589):

   ```bash
   tailscale funnel --bg --https=10000 --set-path /telegram http://127.0.0.1:4589/telegram
   ```

   `OTTO_URL` is then `https://<machine>.<tailnet>.ts.net:10000/telegram`. This publishes
   `/telegram` alone, and it refuses anything without the relay's bearer
   secret. `/app` stays behind `tailscale serve`. Never funnel it.

3. Deploy the Worker, then give it its secrets (each prompts for the value):

   ```bash
   npx wrangler login
   npx wrangler deploy                    # prints https://otto-relay.<you>.workers.dev
   npx wrangler secret put BOT_TOKEN      # the bot token from ~/.otto/state/.env
   npx wrangler secret put TELEGRAM_SECRET
   npx wrangler secret put RELAY_SECRET
   npx wrangler secret put OTTO_URL
   npx wrangler secret put ALLOWED_CHATS  # same ids as allowFrom, comma-separated
   ```

## Turn it on

Order matters: Otto first, Telegram second. A polling Otto deletes the
webhook every time it starts (grammY's `bot.start()` does), so the relay only
stays in front while `access.json` says relay.

1. Otto's side — add the secret to `~/.otto/state/.env`:

   ```
   OTTO_RELAY_SECRET=<RELAY_SECRET>
   ```

   and to `~/.otto/state/access.json`:

   ```json
   "telegramMode": "relay",
   "relayUrl": "https://otto-relay.<you>.workers.dev"
   ```

   Restart Otto (`bash ~/.otto/scripts/otto-ctl.sh restart`). Its log says `relay mode as @<bot>`. Telegram holds anything
   sent in the gap and delivers it once the webhook is set.

2. Point Telegram at the Worker:

   ```bash
   source ~/.otto/state/.env
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d url="https://otto-relay.<you>.workers.dev/telegram" \
     -d secret_token="<TELEGRAM_SECRET>" \
     -d max_connections=1
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
   ```

   `max_connections=1` keeps Telegram's own deliveries in order.

Check it: send a message with Otto stopped — one notice comes back, and the
message is answered after Otto starts again.

## Turn it off

1. Make sure nothing is stranded in the queue (Otto in relay mode drains it
   every minute; this peeks without acking):

   ```bash
   curl -s -X POST -H "authorization: Bearer <RELAY_SECRET>" https://otto-relay.<you>.workers.dev/drain
   ```

   `[]` means empty.

2. Take Telegram back:

   ```bash
   source ~/.otto/state/.env
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"
   ```

   Pending updates are kept and come in over `getUpdates`.

3. Remove `telegramMode` (or set it to `"polling"`) in `access.json` and restart
   Otto. Optionally `tailscale funnel --https=10000 --set-path /telegram off`
   and `npx wrangler delete`.

## Tests

```bash
cd relay && bun test
```

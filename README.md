# bosch-bot

Express + Playwright service that drives the Bosch heat-pump advisor and returns the
recommendation to auraos.

## Hardened instance (Option B — staging / rebuild)

This branch is the **hardened, Bearer-only** instance for the rebuild/staging. It holds
**no Supabase service-role key** and makes **zero direct DB/Storage calls**:

- Inbound `POST /api/run-advisor` requires `Authorization: Bearer <BOSCH_BOT_WEBHOOK_SECRET>`
  (constant-time compare, fail-closed: an unset secret rejects every request).
- After the advisor run, the bot POSTs the result to the auraos callback
  (`AURAOS_CALLBACK_URL`) with the same Bearer secret. auraos owns the DB write.
- The recommendation PDF bytes are POSTed to the auraos PDF endpoint
  (`AURAOS_PDF_URL`, or derived from the callback origin); auraos uploads + signs +
  stamps `pdf_url` server-side.
- Product matching is delegated to auraos: the bot ships **model/name strings**
  (`matched_product_id_innen` = the inner model e.g. `CS6800iAW 12 MB`;
  `matched_product_id_aussen` = `Compress <serie> <AW ...>`), **not** uuids.

The **old** bot (with the service-role key + direct DB writes) stays untouched and serves
the live alt site until cutover.

## Environment

See [.env.example](./.env.example):

| Var | Required | Purpose |
|---|---|---|
| `BOSCH_BOT_WEBHOOK_SECRET` | yes | Shared Bearer secret (both directions). Identical to auraos Vercel env. |
| `AURAOS_CALLBACK_URL` | yes | auraos result-callback endpoint. |
| `AURAOS_PDF_URL` | no | auraos PDF-upload endpoint; derived from the callback origin if unset. |
| `PORT` | no | Listen port (default 3000). |

The `BOSCH_BOT_WEBHOOK_SECRET` is a secret: never commit it, never log it, never paste it
into a chat or third-party service.

## Run

```
npm ci --omit=dev   # Dockerfile path (uses package-lock.json)
node index.js
```

Deploy is a Railway step (Dockerfile builder, see `railway.toml`).

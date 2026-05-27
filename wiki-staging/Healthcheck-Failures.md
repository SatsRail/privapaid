# Healthcheck Failures

`/api/health` is the endpoint Railway, EC2 ALB, and Kubernetes probes hit to decide whether your container is alive. Understanding its output is the first step in diagnosing any "deploy looks fine but healthcheck fails" situation.

## Response shape

```json
{ "status": "ok", "db": "connected", "satsrail": "reachable" }
```

| Field | Possible values |
|---|---|
| `status` | `"ok"` (HTTP 200) or `"degraded"` (HTTP 503) |
| `db` | `"connected"` or `"disconnected"` |
| `satsrail` | `"reachable"`, `"unreachable"`, `"http_<code>"`, or `"not_configured"` |

## Failure modes

### `db: "disconnected"` → HTTP 503

Postgres isn't responding to `SELECT 1`. Causes:

- `DATABASE_URL` env var missing or malformed
- Postgres container not yet started (race during fresh deploy)
- Connection pool exhausted (Prisma's default is 20 connections per `connection_limit` query param)
- DB credentials wrong (e.g. you rotated the Postgres password but didn't update `DATABASE_URL`)
- Network unreachable (firewall, VPC config)

**Debug:**
```bash
psql "$DATABASE_URL" -c "SELECT 1;"
```

If that fails from the same container, the app fails too. Fix the underlying connectivity.

### `satsrail: "unreachable"` → HTTP 503

The health endpoint tried to fetch `${SATSRAIL_API_URL}/pub/exchanges` and got a network error (5-second timeout). Causes:

- `SATSRAIL_API_URL` missing or pointing somewhere wrong
- Outbound HTTPS blocked from your platform
- SatsRail temporarily down (very rare)

**Debug:**
```bash
curl --max-time 5 https://satsrail.com/api/v1/pub/exchanges
```

If that works from the host but not the container, you have a container networking issue (NAT, security group, VPC).

### `satsrail: "http_<code>"` → HTTP 200

Non-2xx response from SatsRail but a response received. **This does NOT degrade the healthcheck status to 503** — by design. The app is reachable; SatsRail being temporarily 503 shouldn't take down PrivaPaid.

If `http_5xx` persists, SatsRail has an incident. Check [satsrail status page](https://status.satsrail.com).

### `satsrail: "not_configured"` → HTTP 200

`SATSRAIL_API_URL` env var isn't set. Healthcheck passes (app is alive), but no payment flows will work. Set the variable.

## Healthcheck never returns (timeout)

Different category of failure — the app isn't responding at all. Likely causes:

- **Container crashed at startup.** Check deploy logs for the entrypoint output and any `process.exit(1)` calls. Common: missing env vars (see [[Missing CONTENT_KEK]]), failed migration ([[Stuck Migrations]]).
- **Container is running but the Next.js server didn't bind to the expected port.** Check `PORT` env var (defaults to 3000) matches what the platform's probe expects.
- **App startup is slow** (large schema, OTEL initialization, large `instrumentation.ts`). The container is fine but the probe fired before the server was listening. Increase `healthcheckTimeout` in `railway.toml` (currently 300 seconds).

## Healthcheck path mismatch

If your platform's probe targets `/` or `/health` instead of `/api/health`, you'll get 404s. Check `railway.toml`:

```toml
[deploy]
healthcheckPath = "/api/health"
```

For EC2 ALB target groups, the path is configured on the target group, not in the repo.

## See also

- [[Stuck Migrations]] — if the entrypoint exits before `node server.js` starts
- [[Missing CONTENT_KEK]] — another startup-fail mode
- [[Operator Playbook]] — wiring `/api/health` into an uptime monitor

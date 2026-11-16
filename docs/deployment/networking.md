# Networking and port exposure

## Production ports

| Service | Listens on | Reached by | Public? |
| --- | --- | --- | --- |
| Platform API | `127.0.0.1:5000` | host Nginx | no |
| Stays API | `127.0.0.1:5100` | host Nginx | no |
| Nginx | `0.0.0.0:80`, `0.0.0.0:443` | Internet | yes |
| PostgreSQL | `127.0.0.1:5432` | both APIs | no |
| Redis | `127.0.0.1:6379`, `[::1]:6379` | both APIs | no |

Only 22/80/443 are open in `ufw`. The API containers publish nothing.

## Why host networking in production

PostgreSQL and Redis are **host services bound to loopback**, not containers.
The obvious bridge-network design would require one of:

1. changing `listen_addresses` and `pg_hba.conf` to accept the Docker bridge
   subnet, plus a `ufw` rule — i.e. exposing the database to make container
   networking convenient; or
2. publishing 5432/6379 on the host and routing through it — the same exposure
   with extra hops.

Host networking avoids both. The containers share the host's network namespace,
so `127.0.0.1:5432` means what it already means to the PM2 process. Nothing about
the database configuration changes.

`deploy/compose.production.yml` therefore sets `network_mode: host` and no
`ports:` or `networks:` for either service. With host networking those keys are
ignored, so leaving them in would create a false impression of isolation.

## Security implications of host networking

Host networking is a real trade-off, not a free switch. What it costs:

1. **No network namespace boundary.** A compromised API process can reach any
   service bound to host loopback — including Postgres and Redis — exactly as the
   PM2 process can. Bridge networking would not have prevented this either (the
   app needs those credentials), but it would have made lateral movement to other
   host services slightly harder.
2. **Port collisions are global.** Only one process can bind `5000` or `5100`.
   PM2's `expedition-api` already holds 5000. The cutover runbook stops the PM2
   process before starting the Platform container; Stays on 5100 can start
   alongside it because nothing else uses that port.
3. **`HOST` is the only thing keeping the API off the internet.** With host
   networking, binding `0.0.0.0:5000` publishes the API directly, bypassing
   Nginx and TLS. The image sets `HOST=127.0.0.1` and Compose repeats it. Verify
   after every deploy:

   ```bash
   ss -lntp | grep -E ':5000|:5100'
   # expected: 127.0.0.1:5000 and 127.0.0.1:5100 — never 0.0.0.0 or [::]
   ```

4. **ufw does not protect a directly bound port** if the process binds
   `0.0.0.0`; the connection never traverses the rule that was supposed to stop
   it. Loopback binding is the control, not the firewall.
5. **IPv6 is separate.** `127.0.0.1` is IPv4-only. Do not add `::` binding
   "for symmetry". Nginx upstreams are IPv4 literals, so IPv6 is not needed.
6. **DNS and outbound traffic use the host resolver.** That is the intent: the
   apps must reach Stripe, Resend, Cloudinary and the database by the same names
   the PM2 process uses.
7. **Container limits still apply.** `mem_limit`, `no-new-privileges` and the
   non-root user are independent of the network mode and remain in force.

What it buys: the database keeps its loopback-only posture, no new firewall
rules are required, and the host's existing Nginx/TLS setup continues to be the
only ingress.

## Local development

`deploy/compose.local.yml` deliberately uses the default bridge network:

```yaml
ports:
  - "127.0.0.1:5000:5000"
  - "127.0.0.1:5100:5100"
extra_hosts:
  - "host.docker.internal:host-gateway"
```

- The `127.0.0.1:` prefix on the host side keeps the ports off the LAN, matching
  production.
- `HOST=0.0.0.0` inside the container is correct for bridge networking: the
  container must accept traffic on its own interface for the port mapping to
  work. It is not published beyond loopback.
- The dev Postgres from `docker-compose.yml` listens on host `5433`; containers
  reach it through `host.docker.internal`.

Never copy the local `HOST=0.0.0.0` into production.

## Nginx

`deploy/nginx/api-routing.conf` sends four Stays locations to 5100 and leaves
`location /` on 5000. Installation, ordering rules and rollback are in
`deploy/nginx/README.md`.

The catch-all keeps the Socket.IO upgrade headers. Narrowing it to a path list
would drop websocket upgrades for routes added later.

## Verification checklist

Run after any deploy or Nginx change:

```bash
# 1. Only loopback listeners for the apps
ss -lntp | grep -E ':5000|:5100'

# 2. Containers cannot be reached from outside
curl -m 3 http://<public-ip>:5000/health   # must time out / refuse
curl -m 3 http://<public-ip>:5100/health   # must time out / refuse

# 3. Host Nginx still owns 80/443
ss -lntp | grep -E ':80|:443'

# 4. Database and Redis are loopback-only
ss -lntp | grep -E ':5432|:6379'

# 5. Application-level routing and isolation
./deploy/scripts/verify-deployment.sh

# 6. ufw unchanged
ufw status verbose
```

`verify-deployment.sh` proves that port 5100 serves Stays and returns 404 for
Tours, and that port 5000 still serves both during the alias period.

## What this design does not solve

- There is no network policy between the two apps. They trust each other because
  they share a database and a Redis instance; that trust is explicit, not
  accidental.
- Host networking is Linux-only. On macOS/Windows use the local bridge Compose
  file; do not expect `network_mode: host` to behave the same.
- A future move to managed Postgres/Redis would make bridge networking the better
  default. Revisit this document at that point rather than layering exceptions.

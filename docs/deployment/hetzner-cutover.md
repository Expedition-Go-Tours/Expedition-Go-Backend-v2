# Hetzner cutover runbook

> **Status: executed on 2026-11-16.**
>
> Phases 1–5 were run with explicit approval: Docker 29.9.3 and Compose 5.7.1
> installed; `/etc/travio/*.env` created; both `sha-d92644f` images pulled;
> Stays started on 5100; Nginx split for the four Stays prefixes; Platform
> moved from PM2 to its container. The cutover interruption was ~4–5 seconds.
> PM2 is retired from boot (`pm2-deploy.service` disabled, resurrect dump
> emptied) and retained as a manual rollback path.
>
> A database dump and configuration archive were taken immediately afterwards;
> there was no schema migration in this release. The "Verified current state"
> table below is the pre-cutover snapshot and is kept as the starting point for
> a rollback or review.

## Verified current state (read-only)

Checked against `ssh root@2.28.45.181` without changing anything:

| Item | Observed |
| --- | --- |
| Host | 2 vCPU, 3,809 MB RAM, ~2,312 MB available, 4 GB swap, 46 GB free disk |
| Docker | not installed (`docker: command not found`); systemd unit inactive |
| PM2 | `expedition-api` (~312 MB RSS) + `pm2-logrotate` only |
| CLIP service / Discord bot | defined in `ecosystem.config.js`, **not running** |
| Nginx | host-installed; `apiv1.travioafrica.com.conf` and `api.brands.conf` proxy `location /` → `127.0.0.1:5000` |
| PostgreSQL | `127.0.0.1:5432` |
| Redis | `127.0.0.1:6379`, `[::1]:6379` |
| Port 5000 | bound by PM2 on `0.0.0.0` |
| Firewall | `ufw` active, allowing 22/80/443 |
| App directory | `/home/deploy/Expedition-Go-Backend-v2` |

The application currently binds `0.0.0.0:5000` because the old entry point did.
The new entry point defaults to `127.0.0.1` (`HOST || '127.0.0.1'`). Verify
Nginx only ever proxies `127.0.0.1:5000` before the first PM2 restart; it does
today, so loopback binding is safe. If anything external connects to port 5000
directly, set `HOST=0.0.0.0` deliberately and document why.

## Memory budget

| Phase | Platform | Stays | PM2 | Total |
| --- | ---: | ---: | ---: | ---: |
| Before | — | — | 312 MB | 312 MB |
| Stays introduced | — | ≤384 MB | 312 MB | ~700 MB |
| Both containers | ≤768 MB | ≤384 MB | stopped | ~1.15 GB |

Available memory is ~2.3 GB, so both containers fit with headroom. The Compose
limits are ceilings, not reservations; observed usage will be lower.

## Phase 0 — Freeze and back up

1. Announce a maintenance window. No deploys during the window.
2. Database backup:

   ```bash
   pg_dump --format=custom --no-owner --no-privileges \
     "$DATABASE_URL" > /var/backups/travio-$(date +%Y%m%d-%H%M).dump
   ```

3. Configuration backup:

   ```bash
   tar czf /var/backups/travio-config-$(date +%Y%m%d-%H%M).tgz \
     /etc/nginx /home/deploy/Expedition-Go-Backend-v2/.env \
     /home/deploy/Expedition-Go-Backend-v2/ecosystem.config.js
   ```

4. Record the PM2 process list:

   ```bash
   pm2 save && pm2 list
   ```

5. Record the running commit:

   ```bash
   cd /home/deploy/Expedition-Go-Backend-v2 && git rev-parse HEAD
   ```

Rollback for this phase: none needed.

## Phase 1 — Install Docker (not done yet)

```bash
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker run --rm hello-world
```

The default bridge network is fine for the daemon; the API containers use host
networking.

Verification:

```bash
docker version
docker compose version
ufw status verbose      # must still show 22/80/443 only
ss -lntp | grep 2375    # must be empty — no remote daemon API
```

Rollback: `apt-get remove --purge docker-ce docker-ce-cli containerd.io ...`
before any container has been started. After Phase 3, roll back containers
first.

## Phase 2 — Prepare deployment inputs (no traffic change)

1. Create directories and env files:

   ```bash
   install -d -m 0750 /etc/travio /var/lib/travio /opt/travio/api
   install -m 0600 /dev/null /etc/travio/platform-api.env
   install -m 0600 /dev/null /etc/travio/stays-api.env
   ```

   `platform-api.env` starts as a copy of the current `.env`.
   `stays-api.env` needs only what `validateStaysEnv()` requires:
   `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CLOUDINARY_*`
   (plus optional `REDIS_URL`, `SENTRY_DSN`, `ALLOWED_ORIGINS`,
   `CLIENT_URL`, `SUPPLIER_DASHBOARD_URL`).

   Two rules that are easy to get wrong:

   - `JWT_SECRET` and `JWT_REFRESH_SECRET` **must be byte-identical** in both
     files. A token minted for the Platform API has to verify in the Stays
     service, otherwise every Stays request returns 401 after cutover.
   - `DATABASE_URL` and `REDIS_URL` must also match, since both processes read
     the same data and cache keys.

   Compose sets `NODE_ENV=production`, `HOST=127.0.0.1` and `TZ=UTC` itself, so
   those cannot be lost by a bad env file. Everything else is the env file's
   responsibility.

   Validate before starting anything:

   ```bash
   PLATFORM_IMAGE=ghcr.io/expedition-go-tours/platform-api:sha-<commit> \
   STAYS_IMAGE=ghcr.io/expedition-go-tours/stays-api:sha-<commit> \
   docker compose -f /opt/travio/api/deploy/compose.production.yml config >/dev/null
   ```

2. Runtime differences from PM2 worth knowing before the cutover:

   | Concern | PM2 today | Container |
   | --- | --- | --- |
   | Process model | `exec_mode: cluster`, 1 instance; God owns the socket | One process, binds directly |
   | Memory guard | `max_memory_restart: 500M`, `--max-old-space-size=400` | `mem_limit: 768m`; Node sizes the heap from the cgroup |
   | `NODE_ENV` | Set in `ecosystem.config.js` | Set in Compose |
   | Timezone | Host timezone | `TZ=UTC` (Africa/Accra is also UTC+0) |
   | Shutdown | SIGINT, `kill_timeout: 15000` | SIGTERM, `stop_grace_period: 20s`, app drains in 8s |
   | Env source | `.env` + PM2's cached copy | `/etc/travio/<app>.env` |
   | Logs | `/home/deploy/.pm2/logs/*.log` | `docker logs`, json-file capped at 10 MB × 5 |

   After the Platform container has run for a business cycle, compare its
   observed RSS against the 768 MB ceiling. If it approaches the limit, raise the
   limit rather than letting the OOM killer be the restart policy.

3. Optional: place the Compose file at `/opt/travio/api/deploy/`. The deploy
   scripts now default to `<repo>/deploy/compose.production.yml`, and the release
   workflow syncs the checkout to the release commit, so the copy is only for
   manual/legacy runs:

   ```bash
   install -m 0644 /home/deploy/Expedition-Go-Backend-v2/deploy/compose.production.yml \
     /opt/travio/api/deploy/compose.production.yml
   ```

   Or export `COMPOSE_FILE` in the deploy environment instead of copying.

4. Authenticate to GHCR with a **read-only** package token:

   ```bash
   echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u <user> --password-stdin
   ```

5. Pull both images without starting anything:

   ```bash
   docker pull ghcr.io/expedition-go-tours/platform-api:sha-<commit>
   docker pull ghcr.io/expedition-go-tours/stays-api:sha-<commit>
   ```

Rollback: remove `/etc/travio`, `/opt/travio/api`, `docker logout ghcr.io`.

## Phase 3 — Introduce Stays only

The Platform API keeps running under PM2. Stays starts on its own port, so
nothing is interrupted.

```bash
cd /home/deploy/Expedition-Go-Backend-v2
./deploy/scripts/deploy-stays.sh ghcr.io/expedition-go-tours/stays-api:sha-<commit>
```

`deploy-stays.sh`:

- validates the image belongs to `stays-api` and is not `:latest`;
- starts only `stays-api` with `--no-deps`;
- waits for `127.0.0.1:5100/ready` to return 200;
- records `STAYS_IMAGE_CURRENT` in `/var/lib/travio/deploy-state.env`;
- rolls back to `STAYS_IMAGE_PREVIOUS` if readiness fails.

Verification:

```bash
curl -s http://127.0.0.1:5100/health | jq
curl -s http://127.0.0.1:5100/ready  | jq
./deploy/scripts/verify-deployment.sh stays

# Prove the Platform process was not restarted:
pm2 describe expedition-api | grep -E 'restarts|uptime'
docker inspect -f '{{.State.StartedAt}}' travio-platform-api 2>/dev/null || true

# Prove Stays does not serve Tours:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5100/api/v1/tours   # 404

# Prove the database and Redis postures are unchanged:
ss -lntp | grep -E ':5432|:6379|:5100'
```

Rollback: `./deploy/scripts/rollback-stays.sh`, or
`docker compose -f /opt/travio/api/deploy/compose.production.yml stop stays-api`.
No Nginx change has been made yet, so public traffic never touched Stays.

## Phase 4 — Nginx split

This is the first step that changes public routing. Do it in a low-traffic
window.

1. Install the fragment:

   ```bash
   install -m 0644 /home/deploy/Expedition-Go-Backend-v2/deploy/nginx/api-routing.conf \
     /etc/nginx/snippets/travio-api-routing.conf
   ```

2. In each site config, replace the existing `location / { … }` block with:

   ```nginx
   include /etc/nginx/snippets/travio-api-routing.conf;
   ```

3. Test, then reload:

   ```bash
   nginx -t && systemctl reload nginx
   ```

4. Verify from outside:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://apiv1.travioafrica.com/api/v1/travioghana/supplier/stays/properties  # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://apiv1.travioafrica.com/api/v1/tours                                   # 200
   ```

5. Watch both logs for 15 minutes:

   ```bash
   docker logs -f --tail=100 travio-stays-api
   pm2 logs expedition-api --lines 100
   ```

6. Check the supplier dashboard: property list, calendar, a test reservation
   (then cancel it), finance summary.

Rollback: remove the `include` line, `nginx -t`, `systemctl reload nginx`.
Stays traffic returns to port 5000, which still mounts the same router. The
Stays container can keep running or be stopped independently.

## Phase 5 — Move the Platform API into a container (later, separate approval)

Do not combine this with Phase 4. It is the only step with downtime, because
two processes cannot bind `127.0.0.1:5000`.

1. Stop PM2 and prevent it from restarting the app:

   ```bash
   pm2 stop expedition-api
   pm2 save
   ```

2. Start the Platform container:

   ```bash
   cd /home/deploy/Expedition-Go-Backend-v2
   ./deploy/scripts/deploy-platform.sh ghcr.io/expedition-go-tours/platform-api:sha-<commit>
   ```

3. Verify:

   ```bash
   ./deploy/scripts/verify-deployment.sh
   curl -s https://apiv1.travioafrica.com/api/v1/tours | head -c 200
   ```

4. Only after a full business cycle, remove the PM2 app from startup:

   ```bash
   pm2 delete expedition-api
   pm2 save
   ```

   Keep `ecosystem.config.js` and the previous release checkout in place until
   the next release; they are the rollback path.

Downtime is the interval between `pm2 stop` and `/ready` returning 200 —
typically the Node startup time plus Prisma connection, not a full image pull
(pull the image in Phase 2).

Rollback: stop the Platform container, `pm2 start expedition-api`, confirm
`curl 127.0.0.1:5000/ready`. Because the schema changes are additive, the old
code runs against the new schema.

## What stays on PM2

Even after Phase 5:

- `pm2-logrotate` (log management)
- `clip-service` and `discord-bot` are still defined but not running; they are
  not part of either API image and are unaffected by this cutover.

## Rollback matrix

| Failure | Action | Traffic impact |
| --- | --- | --- |
| Stays image unhealthy | `rollback-stays.sh` | none (not yet routed) |
| Stays healthy but errors under real traffic | remove Nginx include | requests return to port 5000 |
| Nginx config error | restore the backup from Phase 0, `nginx -t`, reload | none if reload is not run with a broken config |
| Platform container unhealthy | `rollback-platform.sh`; if still failing, `pm2 start expedition-api` after stopping the container | brief, bounded by readiness gate |
| Migration fails | deploy jobs do not run; fix forward with a new migration | none |
| Everything fails | stop containers, `pm2 start expedition-api`, remove Nginx include | back to pre-split topology |

## Approval checklist

Before executing any phase, confirm:

- [ ] Maintenance window agreed and announced.
- [ ] Phase 0 backups exist and have been test-restored once.
- [ ] GHCR read token can pull both images.
- [ ] `/etc/travio/*.env` contain the expected keys and are `0600`.
- [ ] `docker compose -f … config` renders with the chosen image tags.
- [ ] `verify-deployment.sh` is present and executable on the host.
- [ ] Someone other than the operator knows how to run the rollback matrix.
- [ ] No other deploy is scheduled in the same window.

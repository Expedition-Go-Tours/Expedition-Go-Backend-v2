# Nginx routing for the two API applications

`api-routing.conf` is a **fragment**, not a site. It contains the `location`
blocks that decide whether a request reaches the Platform API (`127.0.0.1:5000`)
or the Stays API (`127.0.0.1:5100`). It is included inside an existing
`server { … }` block; it does not declare one.

## Current production behaviour (since 2026-11-16)

Both vhosts (`apiv1.travioafrica.com.conf`, `api.brands.conf`) include this
fragment. The four Stays locations proxy to `127.0.0.1:5100`; `location /`
proxies everything else to `127.0.0.1:5000` with the Socket.IO upgrade headers
intact.

The Platform API still mounts the Stays router, so removing the include is a
valid rollback that needs no application deploy. If the Stays container is
stopped while the include is present, Stays requests fail until the include is
removed — which is why the routing change is a reviewed step, separate from a
Platform deploy.

The split is live, not a proposal. `deploy/scripts/verify-public-ingress.sh`
checks it from outside the host, and the release workflow runs that check after
both deploy jobs.

## Paths routed to Stays

| Location | Result |
| --- | --- |
| `= /api/v1/travioghana/supplier/stays` | 5100 |
| `^~ /api/v1/travioghana/supplier/stays/` | 5100 |
| `= /api/travioghana/supplier/stays` | 5100 |
| `^~ /api/travioghana/supplier/stays/` | 5100 |
| everything else | 5000 |

Both API prefixes are listed on purpose. `/api` remains the live contract for
the supplier dashboard; `/api/v1` is canonical and points at the same router.
Routing only one of them would send half the traffic to a process that is about
to be retired from that path.

The `^~` modifier suppresses regex-location evaluation for these prefixes. If a
site later adds a regex location, Stays traffic cannot silently fall back to the
Platform API. The exact-match (`=`) entries cover the collection URL with no
trailing slash; the prefix entries cover everything beneath it.

## Why `location /` must not be narrowed

The catch-all carries the Socket.IO upgrade headers (`Upgrade`,
`Connection 'upgrade'`, `proxy_cache_bypass $http_upgrade`). Scoping it to a
prefix list would drop websocket upgrades for routes added later. Nginx matches
the longest static prefix, so the four Stays locations win for Stays paths and
`location /` keeps everything else, unchanged.

## Installing the fragment

Already installed on both vhosts. These steps are kept for a rebuild or a new
vhost.

1. Copy it next to the site config, outside `sites-enabled` so it cannot be
   loaded twice by accident:

   ```bash
   install -m 0644 deploy/nginx/api-routing.conf /etc/nginx/snippets/travio-api-routing.conf
   ```

2. In each site's `server` block, replace the existing `location / { … }` with:

   ```nginx
   include /etc/nginx/snippets/travio-api-routing.conf;
   ```

3. Test before reloading — a syntax error in a fragment takes down every site
   that includes it:

   ```bash
   nginx -t
   ```

4. Reload only after `nginx -t` succeeds:

   ```bash
   systemctl reload nginx
   ```

## Verifying the routing

From any machine with public DNS:

```bash
./deploy/scripts/verify-public-ingress.sh
```

For every configured vhost it asserts:

- `/api/v1/tours` and `/api/tours` → 200 with `X-Served-By: platform-api`
- both Stays prefixes → 401 with `X-Served-By: stays-api`
- Socket.IO upgrade → 101

`X-Served-By` is set by each application, so the check proves which upstream
answered instead of inferring it from a status code that both services can
produce. Override the host list with `PUBLIC_HOSTS="a.example b.example"`.

`deploy/scripts/verify-deployment.sh` remains the direct loopback check. It
proves the containers answer on 5000/5100 and that the Stays process does **not**
serve Tours.

For a manual spot check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://apiv1.travioafrica.com/api/v1/tours
curl -s -o /dev/null -w '%{http_code}\n' https://apiv1.travioafrica.com/api/v1/travioghana/supplier/stays/properties
```

## Rollback

Restore the pre-include vhost backups (or delete the `include` line), run
`nginx -t`, then `systemctl reload nginx`. Stays requests return to port 5000,
where the Platform API still mounts the same router and the same guards. No
application change is required.

This path was drilled live on 2026-11-16 with no downtime: both upstreams served
Stays during the drill. Backups from the cutover are under
`/var/backups/nginx-*`.

## Security notes

- Both upstreams are loopback addresses. Neither application is published on a
  public interface; `ufw` continues to allow only 22/80/443.
- `client_max_body_size 50M` is preserved on every location. Upload limits are
  enforced twice — here, and by the upload rate limiter inside each app — so a
  large body is rejected by Nginx before it is buffered by Node.
- `X-Forwarded-For` is appended, not replaced, and both apps run with
  `trust proxy` enabled so rate limiting keys on the real client address.

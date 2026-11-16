# Nginx routing for the two API applications

`api-routing.conf` is a **fragment**, not a site. It contains the `location`
blocks that decide whether a request reaches the Platform API (`127.0.0.1:5000`)
or the Stays API (`127.0.0.1:5100`). It is included inside an existing
`server { … }` block; it does not declare one.

## Current production behaviour

Today both vhosts (`apiv1.travioafrica.com.conf`, `api.brands.conf`) proxy
`location /` to `127.0.0.1:5000`. There is no path routing at all, because there
is only one application. The Platform API still mounts the Stays router, so
Stays requests are served correctly by port 5000 today.

The fragment is therefore **additive**: it moves Stays requests to 5100 without
touching the catch-all. If the Stays container is stopped, Stays requests fail
until the include is removed — which is why the cutover is a reviewed, separate
step, not part of a Platform deploy.

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

From the VPS:

```bash
# Stays paths must reach 5100 (401 = route exists, auth required)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/v1/travioghana/supplier/stays/properties
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/travioghana/supplier/stays/properties

# Everything else must still reach 5000 (200 = public Tours collection)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/v1/tours
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/tours
```

The same assertions are automated in `deploy/scripts/verify-deployment.sh`, which
talks to the containers directly and separately proves that the Stays process
does **not** serve Tours.

## Rollback

Delete the `include` line, run `nginx -t`, then `systemctl reload nginx`. Stays
requests return to port 5000, where the Platform API still mounts the same
router and the same guards. No application change is required, and no traffic is
served by a process that is not already running in production today.

## Security notes

- Both upstreams are loopback addresses. Neither application is published on a
  public interface; `ufw` continues to allow only 22/80/443.
- `client_max_body_size 50M` is preserved on every location. Upload limits are
  enforced twice — here, and by the upload rate limiter inside each app — so a
  large body is rejected by Nginx before it is buffered by Node.
- `X-Forwarded-For` is appended, not replaced, and both apps run with
  `trust proxy` enabled so rate limiting keys on the real client address.

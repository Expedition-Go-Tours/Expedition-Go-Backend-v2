# Rollback drills

A rollback that has never been run is a hypothesis. This records what has been
exercised, what has not, and the exact commands for the remaining case.

## Status

| Scope | State | Evidence |
| --- | --- | --- |
| Stays image | **drilled 2026-11-16** | short-SHA ↔ long-SHA tag of the same image, real container recreate, readiness gate passed |
| Nginx routing | **drilled 2026-11-16** | pre-include vhosts restored, Stays still served by 5000, split re-applied, Stays back on 5100; no downtime |
| Database restore | **automated weekly + manual 16 Nov** | `docs/deployment/backup-restore.md` |
| Platform image (`rollback-platform.sh`) | **not drilled** | previous image is recorded (`PLATFORM_IMAGE_PREVIOUS`); needs a window |
| Platform → PM2 fallback | **not drilled** | needs a window; PM2 app definition is removed, ecosystem file retained |

## Stays image rollback (executed)

The same-image deploy was a no-op at the container level, so the drill used the
short and long SHA tags of the same image to force real recreates:

```bash
./deploy/scripts/deploy-stays.sh \
  ghcr.io/expedition-go-tours/stays-api:sha-d92644fd3bfdbb1b9936816951ca06e1434abe8b
./deploy/scripts/rollback-stays.sh
```

Observed:

- `Container travio-stays-api Recreate` / `Recreated` both times.
- `/ready` returned 200 on the first or second attempt after each recreate.
- `deploy-state.env` swapped `STAYS_IMAGE_CURRENT` and `STAYS_IMAGE_PREVIOUS`.
- `travio-platform-api` `StartedAt` did not change.

The scripts now also require the container to run the expected image and be
Docker-healthy before `/ready`; a port-only check previously accepted a stale
PM2 process.

## Nginx routing rollback (executed)

1. Saved the post-cutover vhosts, restored the pre-include backups.
2. `nginx -t` → reload.
3. Verified Stays still returned 401 through port 5000 (the Platform still
   mounts the router), and Tours 200.
4. Restored the post-cutover vhosts, `nginx -t` → reload.
5. Verified Stays returned 401 again and `travio-stays-api` logged the request.

No downtime: both upstreams served Stays during the drill.

## Platform image rollback (planned)

The previous image is recorded, e.g. `PLATFORM_IMAGE_PREVIOUS=…/platform-api:sha-5d8a6b3`.
In a low-traffic window:

```bash
cd /home/deploy/Expedition-Go-Backend-v2
./deploy/scripts/rollback-platform.sh
./deploy/scripts/verify-deployment.sh
```

Then deploy the intended image forward again. Confirm `travio-stays-api`
`StartedAt` is unchanged.

## Platform → PM2 fallback (planned)

Use only if the container cannot be recovered. This causes an interruption
because two processes cannot bind `127.0.0.1:5000`.

1. Stop the container:

   ```bash
   docker stop travio-platform-api
   ```

2. Start the PM2 app from the ecosystem file (the app definition was removed
   from the daemon during the cutover; the file is still authoritative):

   ```bash
   su - deploy -c \
     "cd /home/deploy/Expedition-Go-Backend-v2 && pm2 start ecosystem.config.js --only expedition-api"
   ```

   Do **not** enable `pm2-deploy.service` unless PM2 is meant to survive a
   reboot. The container is the normal runtime.

3. Verify `/health`, `/ready`, both Tours prefixes and the public vhosts.

4. Return to the container:

   ```bash
   su - deploy -c "pm2 stop expedition-api && pm2 delete expedition-api && pm2 save --force"
   docker start travio-platform-api
   ```

   Then run `verify-deployment.sh` and the public-ingress check.

## Acceptance for the remaining drills

- Record the container image and `StartedAt` before and after.
- Confirm the other application's `StartedAt` does not change.
- Run `verify-deployment.sh` and `verify-public-ingress.sh` after the drill.
- Append the result here, including the date and any deviation.

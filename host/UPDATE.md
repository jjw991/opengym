# openGym on this PC: update, backup, restore, Coach token

Everything here runs from an **Administrator PowerShell**, because the PM2 daemon is elevated (S4U boot task, RunLevel=Highest). Running pm2 from a normal shell or Git Bash fails with `EPERM //./pipe/rpc.sock` and leaves a stray daemon behind.

| What | Where |
|---|---|
| App + our host layer | `C:\Users\jwcb2\opengym\app` (fork `jjw991/opengym`, branch `main`) |
| Data (BACK UP) | `app\data` (`db.json`, `state-<uid>.json`, `coach.json`, `secret`, `vapid.json`) |
| Config | `app\.env` (gitignored: RP_ID, ORIGIN, ACCESS_PIN, ADMIN_UIDS, INVITE_ONLY, ...) |
| PM2 apps | `opengym-api` :4201, `opengym-web` :4200 (`host\ecosystem.config.cjs`) |
| Public URL | `https://gym.jordanwallace.me`, via the tunnel ingress in `~\.cloudflared\config.yml` |
| Boot + watchdog | `homedash\scripts\ensure-homedash.ps1` guards homedash and both openGym apps (tasks `HomeDash-PM2-Startup` and `HomeDash-Watchdog`). Log: `homedash\logs\ensure-homedash.log` |
| Nightly backup | task `openGym-Backup` at 01:30 → `host\backup.ps1` → `opengym\backups\opengym-YYYY-MM-DD.zip`, keeps 30. Log: `host\logs\backup.log` |
| Log rotation | `pm2-logrotate` module: 10 MB per file, keeps 7, gzip, also rotates daily |

**Never** run `git clean -fdx` in `app\`. It deletes `data\` and `.env`.

## Update to the latest upstream

1. On GitHub, open `jjw991/opengym` and click **Sync fork**.
2. Take a backup first:
   `powershell -ExecutionPolicy Bypass -File C:\Users\jwcb2\opengym\app\host\backup.ps1`
3. Pull:
   `git -C C:\Users\jwcb2\opengym\app pull`
4. Rebuild and restart. This runs `npm ci` for the api and frontend, rebuilds `frontend\dist`, reloads both PM2 apps, saves the dump and prints health:
   `powershell -ExecutionPolicy Bypass -File C:\Users\jwcb2\opengym\app\host\build.ps1`
5. Smoke test. Expect `api 200`, `web 200` and `HomeDash 200` in the build output. Then open `https://gym.jordanwallace.me` on the phone and check that a logged workout still shows.

A rebuild wipes anything added by hand to `frontend\dist`, such as `full-body-a1a2b1b2.json`. The master copy is `opengym\plans\full-body-a1a2b1b2.json`.

If an update breaks things: `git -C C:\Users\jwcb2\opengym\app log --oneline -5`, then `git reset --hard <previous>`, then re-run `build.ps1`. `data\` is gitignored, so a reset doesn't touch it.

## Restore from a backup

1. `pm2 stop opengym-api`
2. `Rename-Item C:\Users\jwcb2\opengym\app\data data.broken`
3. `Expand-Archive C:\Users\jwcb2\opengym\backups\opengym-YYYY-MM-DD.zip C:\Users\jwcb2\opengym\app\data`
4. `pm2 start opengym-api`
5. `curl.exe http://127.0.0.1:4201/api/health` should return `{"ok":true,"users":1}`

Drill tested on 2026-10-22: the API booted from a restored zip on a scratch `DATA_DIR` and returned users=1, with the Coach config intact.

**Sync caveat:** the app syncs whole per-user state, and the newest `_ts` wins. If you restore `state-<uid>.json` while the phone holds newer local state, the phone overwrites the restore on its next sync. That's what happened to the hand-written routines on 2026-10-22. To force a restore onto the phone, clear the app's site data on the phone (or reinstall the PWA) **after** restoring, then log back in.

## AI Coach token (Claude provider)

The Coach calls Claude with a long-lived OAuth token from `claude setup-token`. It's stored encrypted in `data\coach.json`, using `data\secret`.

- **Set:** 2026-10-22 (session 2). Long-lived tokens are typically valid for a year. Check the expiry shown when you generate the token and write it here: `expires: ____`.
- **Renew** (before expiry, or straight away if a token leaks):
  1. On any machine with Claude Code, run `claude setup-token` and copy the token. Don't paste it into a chat or a file.
  2. In `https://gym.jordanwallace.me`, open Admin → AI Coach → replace the CLI token → **Test the Coach**. It should pass.
  3. Revoke the old token in your Claude account settings.
- **Symptom of expiry:** "Test the Coach" or a Coach job fails with `401 Invalid bearer token`. The adapter may label this `spawnError`.
- **Caps:** Admin → AI Coach. The plan is 5/day per user and 5/day for the instance.

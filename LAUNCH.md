# Launching M-Star Post

Two ways to run it:

| Mode | Who runs it | Who can use it | How identity works |
|------|-------------|----------------|--------------------|
| **Hosted service** (recommended) | systemd as `mstar_user` on `0.0.0.0:5045` | everyone on the LAN as **guest** (view only); server accounts log in | SSH tunnel (automatic) or a password login page (PAM) |
| **Personal** | you, bound to `127.0.0.1:5045`, reached through your own SSH tunnel | you | the tunnel: you are logged in as your account |

## Who may do what

- **Guests** (anyone opening the hosted URL): browse projects, results, plots and the 2D/3D viewer. Nothing can be changed and the Files tab is closed to them.
- **Logged-in accounts**: create projects, select cases, edit project metadata, run calculations, browse files. File browsing, creating and deleting run **with that account's own Linux permissions**, and calculation jobs run as that account too (so a job can only read case folders the account can read).
- **Owners and admins**: deleting a project, a run or a job (and re-running or cancelling a job) is limited to the project owner / the account that started the job, and to admins (`mstar_user` plus `MSTAR_POST_ADMINS`).

The work is attributed to the account everywhere (project owner, job user, case-id markers).

### Logging in

1. **SSH tunnel (no password typed in the browser):** `ssh -N -L 5045:localhost:5045 <you>@<server>` and open http://localhost:5045. The app sees the owner of the tunnel's socket and logs you in as that account.
2. **Password page:** on the hosted URL click *Guest · Log in* and enter your server account and password. The check is done by PAM through a root-installed helper; the session is a cookie valid for 12 h.

> With plain HTTP the password crosses the LAN unencrypted. Prefer the tunnel on untrusted networks, or put Caddy/nginx with a certificate in front of port 5045.

## Hosted service: one-time setup (root)

The service account cannot act as other users on its own. `deploy/install.sh` installs three small root-owned helpers in `/usr/local/libexec/mstar_post/` (`auth` = PAM check, `fs` = file operations, `run` = job launcher), a sudoers rule that lets **only** `mstar_user` run **only** these programs, `/etc/mstar_post/helper.conf` (allowed roots and the whitelisted task commands), the systemd unit, and a shared group `mstar` for the data folder.

```bash
sudo /data/mstar/python_tools/mstar_post/deploy/install.sh        # as a root-capable admin
sudo usermod -aG mstar <account>                                   # for every account that will run jobs
cd /data/mstar/python_tools/mstar_post/frontend && npm run build   # build the UI once (any user with write access)
sudo systemctl start mstar-post && systemctl status mstar-post
```

Requirements: `mstar_user` exists (no sudo rights needed; the installer adds the narrow rule), accounts that run jobs are in group `mstar` (needed so the service and the user can both write the run folders), and `mstar_user` can read the case folders (for the viewer and case tables).

Updating: `git pull`, `npm run build` in `frontend/`, `sudo systemctl restart mstar-post`. Re-run `install.sh` after changing the helpers or the tool paths.

Troubleshooting: `systemctl status mstar-post` and the log in `<data folder>/service.log` (readable by group `mstar`; also `sudo journalctl -u mstar-post`). *activating (auto-restart)* with exit code 1 usually means port 5045 is already taken, typically by a personal `./run.sh`: stop it (`pkill -f 'uvicorn app.main:app'`). If the service runs but the URL does not answer from other machines, open port 5045 in the server firewall (`sudo ufw allow 5045/tcp`).

Without the helpers (nothing installed under `/usr/local/libexec/mstar_post/`) the app runs in **direct** mode: file operations and jobs run as the account that started the server, only the SSH tunnel logs people in, and the password page says so.

## Personal mode

The server binds to `127.0.0.1` only; reach it through an SSH tunnel.

| Mode       | Server port(s)                   | Open on the Mac          |
|------------|----------------------------------|--------------------------|
| Production | 5045 (API + built UI)            | http://localhost:5045    |
| Dev        | 5045 (API) + 5180 (Vite UI)      | http://localhost:5180    |

## Prerequisites (on the server)

- Python 3 with the backend dependencies (FastAPI, uvicorn, numpy, ...).
- Node.js/npm (only needed to build or develop the frontend).
- Your home quota is full, so point npm's cache at `/data`:
  ```bash
  cd frontend && npm install --cache /data/mstar/.npm-cache-michael
  ```

## Production

On the server:

```bash
cd /data/mstar/python_tools/mstar_post
./run.sh
```

`run.sh` builds `frontend/dist` on first run if it is missing. After changing the UI, rebuild it:

```bash
cd frontend && npm run build
```

Settings (environment variables):

| Variable              | Default                       |
|-----------------------|-------------------------------|
| `PORT`                | `5045`                        |
| `HOST`                | `127.0.0.1` (do not change)   |
| `MSTAR_POST_ROOTS`    | `/data:/data2`                |
| `MSTAR_POST_DATA`     | `/data/mstar/mstar_post_data` |
| `MSTAR_POST_MAX_JOBS` | `1`                           |
| `MSTAR_POST_ADMINS`   | (empty) comma-separated admin accounts |
| `MSTAR_POST_HELPER_DIR` | `/usr/local/libexec/mstar_post` |
| `MSTAR_POST_HELPER_MODE` | `sudo` if the helpers exist there, else `direct` |

Example: `PORT=5046 ./run.sh`.

## SSH tunnel from the Mac

In a Terminal on the Mac:

```bash
ssh -N -L 5045:localhost:5045 michael@<server>
```

Leave it running and open http://localhost:5045. `-N` opens the tunnel without a remote shell; stop it with Ctrl-C.

To avoid retyping, add to `~/.ssh/config` on the Mac:

```
Host mstar
    HostName <server>
    User michael
    LocalForward 5045 localhost:5045
    LocalForward 5180 localhost:5180
    ServerAliveInterval 60
```

Then `ssh -N mstar` forwards both ports.

If 5045 is already used on the Mac (`lsof -i :5045`), forward a different local port:
`ssh -N -L 15045:localhost:5045 michael@<server>` and open http://localhost:15045.

## Dev mode (hot reload)

On the server, in two terminals:

```bash
# terminal 1: backend with auto-reload
cd /data/mstar/python_tools/mstar_post/backend
python3 -m uvicorn app.main:app --reload --host 127.0.0.1 --port 5045

# terminal 2: Vite dev server (proxies /api and WebSockets to 5045)
cd /data/mstar/python_tools/mstar_post/frontend
npm run dev
```

On the Mac, forward 5180 (and optionally 5045):

```bash
ssh -N -L 5180:localhost:5180 -L 5045:localhost:5045 michael@<server>
```

Open http://localhost:5180. If the backend runs on another port, start Vite with
`MSTAR_POST_BACKEND=http://localhost:<port> npm run dev`.

## Keep running after logout

### tmux (recommended)

```bash
tmux new -s mstar_post
cd /data/mstar/python_tools/mstar_post && ./run.sh
# detach: Ctrl-b then d
tmux attach -t mstar_post   # reattach later
```

### nohup

```bash
cd /data/mstar/python_tools/mstar_post
nohup ./run.sh > /data/mstar/mstar_post_data/server.log 2>&1 &
pkill -f "uvicorn app.main:app"   # stop
```

The tunnel from the Mac still has to be opened each time you want to use the app.

## VS Code Remote-SSH

When connected to the server with Remote-SSH, VS Code forwards ports automatically:

1. Start the app from the VS Code integrated terminal (`./run.sh` or the dev commands).
2. VS Code detects 5045/5180 and shows them in the **Ports** panel; otherwise use
   **Ports: Forward a Port** and enter `5045` (and `5180` for dev).
3. Open http://localhost:5045 (or the local address shown in the Ports panel).

The forward stops when the VS Code window is closed; use a plain SSH tunnel for long sessions.

## Troubleshooting

- **Address already in use** on the server: `ss -ltnp | grep 5045`, then stop the old process or use `PORT=...`.
- **Blank page / stale UI**: rebuild with `cd frontend && npm run build`.
- **Job status not updating**: the browser must reach the backend through the same tunnel (WebSockets use `/api` on the same port).
- **`channel ... open failed: connect failed`** in the SSH window: the app is not running on the server, or runs on a different port.

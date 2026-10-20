# Launching M-Star Post

The app runs on the Linux server and is used from a browser on your Mac through an SSH tunnel.

> The server has **no authentication** and binds to `127.0.0.1` only. Never start it with
> `--host 0.0.0.0`; always reach it through an SSH tunnel.

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

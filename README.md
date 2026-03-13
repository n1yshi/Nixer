# Nixer Webpanel

A robust Node.js server that hosts the Nixer Web UI and provides the essential API layer for its functionality.

## Features

The Webpanel launches a local web server to deliver the full Nixer user interface directly in your browser, eliminating the need for a desktop application.

It handles:

- **Account Management** – Registration, login/logout, and profile picture uploads.
- **Local Anime Library** – Manage your personal list (status, progress, ratings) stored via SQLite. No AniList login required.
- **Local Manga Library** – Manga list entries are stored separately from anime (anime “My Lists” stays anime-only).
- **Extension-based Streaming** – Access episode lists and streaming sources through a modular extension system.
- **Manga (Extension-based)** – Search, chapter listing and page fetching via `manga-provider` extensions.
- **Torrents (Provider + Client)** – Torrent search via `anime-torrent-provider` extensions and optional qBittorrent WebUI control.
- **Marketplace Integration** – Install, uninstall, and configure extensions directly from the UI.
- **Watch History & Continuity** – Tracks playback progress per episode and per user.
- **Desktop Interoperability** – Seamlessly export/import data between the desktop app and the webpanel.
- **UI Customization** – Persists theme preferences and home screen layouts.
- **Real-time Updates (`/events`)** – Uses WebSockets for instant synchronization of settings and account changes.
- **CORS Proxy** – Routes external media URLs to bypass browser-side CORS restrictions during streaming.
- **Metadata Integration** – Leverages AniList to fetch titles, cover art, and episode counts.

---

## Getting Started

### Prerequisites

- **Node.js**: Version 20 or higher

### Installation & Launch

```bash
npm install
npm start
```

Once started, access the UI at:

```
http://localhost:10422
```

If you only want it reachable locally:

```bash
HOST=127.0.0.1 npm start
```

---

## Environment Variables

| Variable | Default | Description |
|--------|--------|-------------|
| PORT | 10422 | The port the server listens on |
| HOST | 0.0.0.0 | The bind address |
| NIXER_NODE_DATA_DIR | ~/.config/NixerNodeFull | Main data storage directory |
| NIXER_NODE_DB_PATH | `<dataDir>/nixer-node.db` | Path to the SQLite database file |
| NIXER_SERVER_PASSWORD | – | If set, `/events` requires `?token=...` (API routes are not protected) |
| NIXER_ANIMAP_URL | https://anime.clap.ing | Source for anime metadata |
| NO_COLOR | – | Disables colored output in logs |

### Example

```bash
PORT=10433 NIXER_SERVER_PASSWORD=secure_token_here npm start
```

---

## Data Persistence

Everything is stored in:

```
~/.config/NixerNodeFull
```

Contents:

- `nixer-node.db` – Database containing accounts, lists, history, and settings.
- `assets/profiles/` – User-uploaded profile images.
- `extensions/` – Installed streaming extensions.
- `logs/` – Server-side log files.

## Public VPS Deployment (Important)

- This backend stores state on the machine that runs it (SQLite + uploads + extensions). If you deploy it on a VPS, the data is on the VPS.
- If you run it in Docker or any ephemeral environment, you must mount a persistent volume to `NIXER_NODE_DATA_DIR` (or `NIXER_NODE_DB_PATH`) or you will lose saved anime/manga/torrent settings on restart.
- The API is currently unauthenticated. Do not expose it directly to the internet without a reverse proxy auth layer (Basic Auth, OAuth, VPN, or at least IP allowlisting).
- “Download to PC” only works if the backend (and/or qBittorrent) runs on that PC. A remote VPS cannot write to your local disk.

## VPS Deployment (Recommended)

### 1) Docker Compose (Persistent)

Example `docker-compose.yml` (put it next to this repo or adjust paths):

```yaml
services:
  nixer-webpanel:
    image: node:20-bookworm
    working_dir: /app
    command: bash -lc "npm ci && npm start"
    restart: unless-stopped
    ports:
      - "127.0.0.1:10422:10422"
    environment:
      PORT: "10422"
      HOST: "0.0.0.0"
      NIXER_NODE_DATA_DIR: "/data"
      NO_COLOR: "1"
    volumes:
      - ./:/app
      - nixer_data:/data

volumes:
  nixer_data:
```

Notes:
- Binding to `127.0.0.1:10422` keeps the API private and forces access through a reverse proxy.
- The `nixer_data` volume stores DB/uploads/extensions/logs.

### 2) Reverse Proxy + Auth (Caddy Example)

The API is not authenticated. Put it behind auth.

Minimal Caddyfile example (Basic Auth):

```caddyfile
nixer.example.com {
  encode zstd gzip

  basicauth {
    admin JDJhJDE0JHh4eHh4eHh4eHh4eHh4eHh4eHUuLi4uLi4uLi4uLi4uLi4uLi4uLi4u
  }

  reverse_proxy 127.0.0.1:10422
}
```

Generate the password hash with:

```bash
caddy hash-password --plaintext 'your_password'
```

---

## Project Structure

```
./
├── src/
│   ├── server.mjs                # Express application & API routing
│   ├── db.mjs                    # SQLite database interface
│   ├── config.mjs                # Environment & config management
│   ├── onlinestream-engine.mjs   # Extension-based streaming logic
│   ├── manga-engine.mjs          # Manga provider runtime
│   ├── torrent-engine.mjs        # Torrent provider runtime
│   ├── qbittorrent-client.mjs    # qBittorrent WebUI client
│   ├── extensions-repo.mjs       # Extension lifecycle management
│   ├── anilist-client.mjs        # AniList GraphQL integration
│   ├── local-anime.mjs           # Local collection management
│   ├── local-manga.mjs           # Local manga collection management
│   ├── ws.mjs                    # WebSocket server implementation
│   └── ...
├── public/                       # Pre-built Web UI assets
└── index.js                      # Application entry point
```

## Config Tips

### qBittorrent

- qBittorrent must be reachable from the machine running this backend (VPS -> qBittorrent on VPS, or LAN/VPN).
- Configure in UI Settings: `settings.torrent.qbittorrentHost`, `qbittorrentPort`, `qbittorrentUsername`, `qbittorrentPassword`, optional `qbittorrentCategory`/`qbittorrentTags`.
- The backend uses the qBittorrent WebUI API; make sure WebUI is enabled in qBittorrent.

### Extensions

- Installed extensions live in `NIXER_NODE_DATA_DIR/extensions` (JSON manifests with embedded payload).
- Provider types used:
  - `onlinestream-provider`
  - `manga-provider`
  - `anime-torrent-provider`

---

## Known Limitations

- **Not a 1:1 Go backend**: The original Go project has many more subsystems/routes (scanner, torrent streaming, media streaming, nakama/watch-party, playback manager, etc.).
- **Manga**: Core provider calls work, but the full downloader/queue and library integration are not fully ported.
- **Torrents**: Search + basic qBittorrent actions are implemented, but torrent streaming and the full download pipeline are not fully ported.
- **UI Build Process**: The Web UI inside `public/` is pre-built. There is no internal build step; UI changes must be compiled externally and copied into the directory.
- **API completeness**: Many Go routes exist only as compatibility stubs (see `example/codegen/generated/handlers.json` used for stub registration).

---

## Troubleshooting

**better-sqlite3 installation fails**

Ensure you have the necessary build tools installed.

Linux:
```bash
sudo apt install build-essential python3
```

---

**Port already in use**

Change the default port:

```bash
PORT=10433 npm start
```

---

**Node Version mismatch**

Check your Node version:

```bash
node -v
```

It must be **>= 20**.

---

**Factory Reset**

To wipe all data and settings:

```bash
rm -rf ~/.config/NixerNodeFull
```

---

**VPS: saves disappear after restart**

You are not persisting `NIXER_NODE_DATA_DIR` (or `NIXER_NODE_DB_PATH`). Use a Docker volume / bind mount.

---

**AniList “Not Found” / provider errors**

- AniList can return 404/Not Found for invalid IDs or transient API issues.
- Streaming/manga providers are community extensions and may break when upstream sites change.

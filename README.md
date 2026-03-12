# NixerNodeFull

`NixerNodeFull` is the start of a real NodeJS backend port for `Nixer`.

It is designed around API compatibility with the original Go backend so the existing web app can keep the same look and client-side behavior.

## Current scope

Implemented now:

- static web asset hosting from `public/`
- `GET /events` websocket endpoint with ping/pong and main-tab claim relay
- `GET /api/v1/status`
- `GET /api/v1/settings`
- `POST /api/v1/start`
- `PATCH /api/v1/settings`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- local persistence with SQLite
- local avatar uploads stored on disk

Also included:

- route extraction script to inventory the original Go API contract

## Important limitation

This is not yet the full `1:1` backend.

The original Go project still has roughly hundreds of routes and many subsystems, including:

- library scanning
- metadata providers
- manga handling
- torrents
- media streaming
- extensions
- watch party / nakama
- playback manager

Those still need to be ported module by module.

## Run

```bash
npm install
npm start
```

The existing built web app is served from `public/`.

## Generate route inventory

```bash
npm run routes:extract
```

This writes `generated/routes.json` based on the Go handler annotations so the port can track parity.

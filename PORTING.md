# Porting status (Go -> Node)

This repository currently provides a functional subset of the original Go backend.

The Node server keeps route-compatibility by:

- Implementing a small set of endpoints fully.
- Providing auto-generated **stubs** for the remaining Go endpoints (based on `example/codegen/generated/handlers.json`) to avoid `404`/`405` during UI navigation.

## Not yet 1:1 (module backlog)

- Library scanning (`/api/v1/library/*` beyond basic reads)
- Metadata provider (`/api/v1/metadata-provider/*`, richer `/api/v1/metadata/*`)
- Manga system (`/api/v1/manga/*`, downloads, local assets)
- Torrent client + torrent streaming (`/api/v1/torrent*`, `/api/v1/torrentstream/*`)
- Media streaming (`/api/v1/mediastream/*`, transcoding, attachments)
- Extensions (execution, permissions, marketplace parity)
- Watch party / Nakama (`/api/v1/nakama/*`)
- Playback manager (`/api/v1/playback-manager/*`, playlists)

## Notes

- Generated API stubs are registered in `src/server.mjs` via `src/generated-api-stubs.mjs`.
- Stubs always respond as `{ "data": ... }` with a type-based default (`{}`, `[]`, `true`, or `""`).


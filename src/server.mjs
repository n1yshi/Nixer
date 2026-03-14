import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { execFile } from "node:child_process"
import { Readable } from "node:stream"
import { promisify } from "node:util"

import bcrypt from "bcryptjs"
import cookieParser from "cookie-parser"
import cors from "cors"
import express from "express"
import { v4 as uuidv4 } from "uuid"

import { getAnimeDetails, getMangaDetails, listAnime, listManga, listRecentAnime } from "./anilist-client.mjs"
import { getConfig } from "./config.mjs"
import {
  createDb,
  getContinuityWatchHistory,
  getContinuityWatchHistoryItem,
  deleteMangaMapping,
  deleteLocalAnimeEntry,
  deleteLocalMangaEntry,
  deleteLocalFilesNotIn,
  getAccount,
  getLocalAnimeEntries,
  getLocalAnimeEntry,
  getLocalFiles,
  getLocalMangaEntries,
  getLocalMangaEntry,
  getMangaMapping,
  getSettings,
  getTheme,
  saveAccount,
  saveSettings,
  saveTheme,
  upsertContinuityWatchHistoryItem,
  upsertMangaMapping,
  upsertLocalAnimeEntry,
  upsertLocalMangaEntry,
  upsertLocalFile,
  updateLocalFile
} from "./db.mjs"
import { buildAnimeCollection, buildAnimeEntry, buildLibraryCollection, buildLocalStats, buildRemoteAnimeEntry } from "./local-anime.mjs"
import { buildLocalMangaCollection, buildMangaCollection } from "./local-manga.mjs"
import { defaultHomeItems } from "./defaults.mjs"
import { buildLibraryExplorerFileTree, directorySelector, resolveLibraryRoots, scanVideoFiles } from "./library-explorer.mjs"
import {
  fetchExternalExtensionData,
  getAllExtensions,
  getExtensionPayload,
  getExtensionUserConfig,
  getMarketplaceExtensions,
  getPluginSettings,
  grantPluginPermissions,
  installExternalExtension,
  installExternalExtensionRepository,
  listAnimeTorrentProviderExtensions,
  listCustomSourceExtensions,
  listDevelopmentModeExtensions,
  listExtensionData,
  listMangaProviderExtensions,
  listOnlinestreamProviderExtensions,
  saveExtensionUserConfig,
  savePluginSettings,
  uninstallExternalExtension,
  updateExtensionCode
} from "./extensions-repo.mjs"
import { getOnlineStreamEpisodeList, getOnlineStreamEpisodeSource, listRuntimeOnlinestreamProviderExtensions } from "./onlinestream-engine.mjs"
import { findMangaChapterPages, findMangaChapters, searchManga } from "./manga-engine.mjs"
import {
  getTorrentInfoHash,
  getTorrentMagnetLink,
  normalizeTorrentProviderMedia,
  searchAnimeTorrents,
} from "./torrent-engine.mjs"
import { logError, logInfo, logWarn } from "./logging.mjs"
import { registerGeneratedApiStubs } from "./generated-api-stubs.mjs"
import { clearLogLines, getLogFilenames, getLogText } from "./logs-store.mjs"
import { getQbittorrentConfigFromSettings, QbittorrentClient } from "./qbittorrent-client.mjs"
import { dataResponse } from "./response.mjs"
import { getStatus } from "./state.mjs"
import {
  getDebridSettings,
  getMediastreamSettings,
  getTorrentstreamSettings,
  saveDebridSettings,
  saveMediastreamSettings,
  saveTorrentstreamSettings,
} from "./secondary-settings.mjs"
import { LOCAL_USER_TOKEN, newLocalUser } from "./user.mjs"
import { attachWebsocket } from "./ws.mjs"

const config = getConfig()
const execFileAsync = promisify(execFile)
fs.mkdirSync(config.dataDir, { recursive: true })

const db = createDb(config)
const app = express()
app.set("etag", false)

const recentRequestBuckets = new Map()
const REQUEST_LOG_WINDOW_MS = 1500
let qbClientCache = { key: "", client: null }

process.on("unhandledRejection", (reason) => {
  logError("app", "unhandledRejection", reason)
})

process.on("uncaughtException", (error) => {
  logError("app", "uncaughtException", error)
})

app.disable("x-powered-by")
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use((req, res, next) => {
  const startedAt = Date.now()

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt
    const label = req.path.startsWith("/api/") || req.path.startsWith("/events") ? "API" : "WEB"
    logRequestSummary({
      label,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs
    })
  })

  next()
})
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
  res.setHeader("Pragma", "no-cache")
  res.setHeader("Expires", "0")
  res.removeHeader("ETag")
  next()
})

app.use((req, res, next) => {
  const headerClientId = String(req.get("Nixer-Client-Id") || req.get("Seanime-Client-Id") || "").trim()
  const nixerCookieClientId = String(req.cookies["Nixer-Client-Id"] || "").trim()
  const legacyCookieClientId = String(req.cookies["Seanime-Client-Id"] || "").trim()
  let clientId = headerClientId || nixerCookieClientId || legacyCookieClientId
  if (!clientId) {
    clientId = uuidv4()
  }
  if (clientId !== nixerCookieClientId) {
    res.cookie("Nixer-Client-Id", clientId, {
      httpOnly: false,
      sameSite: "lax",
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
      path: "/"
    })
  }
  if (legacyCookieClientId) {
    res.clearCookie("Seanime-Client-Id", { path: "/" })
  }
  req.clientId = clientId
  next()
})

app.use("/assets/profiles", express.static(config.uploadsDir))
app.use(express.static(config.publicDir, { index: false }))
app.use("/manga-downloads", express.static(path.join(config.dataDir, "manga-downloads")))

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, app: "NixerNodeFull" })
})

app.get("/api/v1/image-proxy", wrapRoute(async (req, res) => {
  const targetUrl = String(req.query?.url || "").trim()
  if (!targetUrl) {
    throw new Error("url is required")
  }

  let headerMap = {}
  const rawHeaders = String(req.query?.headers || "").trim()
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        headerMap = parsed
      }
    } catch {
      throw new Error("headers must be valid JSON")
    }
  }

  const upstreamHeaders = buildProxyRequestHeaders(headerMap, req)
  upstreamHeaders.set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")

  const response = await fetchProxyTarget(targetUrl, upstreamHeaders)
  if (!response.ok) {
    throw new Error(`failed to proxy image (${response.status})`)
  }

  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (
      lowerKey === "content-length" ||
      lowerKey === "content-encoding" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "connection"
    ) {
      continue
    }
    res.setHeader(key, value)
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
  res.status(200)

  if (!response.body) {
    res.end()
    return
  }

  Readable.fromWeb(response.body).pipe(res)
}))

app.get("/api/v1/manga/local-page/:path", wrapRoute(async (req, res) => {
  const encoded = String(req.params.path || "")
  const decoded = safeDecodeURIComponent(encoded)

  const raw = decoded.startsWith("{{manga-local-assets}}")
    ? decoded.slice("{{manga-local-assets}}".length)
    : decoded

  const relative = raw.replace(/^\/+/, "")
  const baseDir = path.join(config.dataDir, "manga-local-assets")
  const resolved = path.resolve(baseDir, relative)
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    const error = new Error("forbidden path")
    error.status = 403
    throw error
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const error = new Error("not found")
    error.status = 404
    throw error
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.sendFile(resolved)
}))

app.get("/api/v1/status", wrapRoute((req, res) => {
  res.json(dataResponse(getStatus({ db, config, req })))
}))

app.get("/api/v1/settings", wrapRoute((_req, res) => {
  res.json(dataResponse(getSettings(db)))
}))

app.get("/api/v1/mediastream/settings", (_req, res) => {
  res.json(dataResponse(getMediastreamSettings(config)))
})

app.patch("/api/v1/mediastream/settings", wrapRoute((req, res) => {
  const next = saveMediastreamSettings(config, req.body)
  notifySyncStateChanged("mediastream-settings")
  res.json(dataResponse(next))
}))

app.get("/api/v1/torrentstream/settings", (_req, res) => {
  res.json(dataResponse(getTorrentstreamSettings(config)))
})

app.patch("/api/v1/torrentstream/settings", wrapRoute((req, res) => {
  const next = saveTorrentstreamSettings(config, req.body)
  notifySyncStateChanged("torrentstream-settings")
  res.json(dataResponse(next))
}))

app.get("/api/v1/debrid/settings", (_req, res) => {
  res.json(dataResponse(getDebridSettings(config)))
})

app.patch("/api/v1/debrid/settings", wrapRoute((req, res) => {
  const next = saveDebridSettings(config, req.body)
  notifySyncStateChanged("debrid-settings")
  res.json(dataResponse(next))
}))

app.get("/api/v1/theme", wrapRoute((_req, res) => {
  res.json(dataResponse(getTheme(db)))
}))

app.patch("/api/v1/theme", wrapRoute((req, res) => {
  const current = getTheme(db)
  const incomingTheme = req.body?.theme && typeof req.body.theme === "object"
    ? req.body.theme
    : req.body
  const next = {
    ...current,
    ...(incomingTheme || {})
  }
  const savedTheme = saveTheme(db, next)
  notifySyncStateChanged("theme")
  res.json(dataResponse(savedTheme))
}))

app.get("/api/v1/status/home-items", (_req, res) => {
  const theme = getTheme(db)
  res.json(dataResponse(theme?.homeItems?.length ? theme.homeItems : defaultHomeItems()))
})

app.post("/api/v1/status/home-items", (req, res) => {
  const currentTheme = getTheme(db)
  const homeItems = Array.isArray(req.body) ? req.body : defaultHomeItems()
  saveTheme(db, {
    ...currentTheme,
    homeItems
  })
  notifySyncStateChanged("theme")
  res.json(dataResponse(homeItems))
})

app.get("/api/v1/desktop-sync/export", wrapRoute((req, res) => {
  res.json(dataResponse(buildDesktopSyncExport({ db, config, req })))
}))

app.post("/api/v1/desktop-sync/import", wrapRoute((req, res) => {
  const account = getAccount(db)
  const token = String(req.cookies?.["nixer_user_token"] || "").trim()
  if (!account || !token || token !== account.token) {
    throw new Error("unauthorized")
  }

  const result = importDesktopSyncPayload({
    db,
    config,
    req,
    payload: req.body,
  })

  notifySyncStateChanged("desktop-sync-import", {
    entriesSynced: result.entriesSynced,
    continuityItemsSynced: result.continuityItemsSynced,
  })
  res.json(dataResponse(result))
}))

app.post("/api/v1/announcements", (_req, res) => {
  res.json(dataResponse([]))
})

app.post("/api/v1/directory-selector", wrapRoute(async (req, res) => {
  const input = String(req.body?.input || "").trim()
  res.json(dataResponse(await directorySelector(input)))
}))

app.post("/api/v1/open-in-explorer", wrapRoute(async (req, res) => {
  if (String(process.env.NIXER_ENABLE_OPEN_IN_EXPLORER || "") !== "1") {
    res.json(dataResponse(false))
    return
  }

  const target = String(req.body?.path || "").trim()
  if (!target) throw new Error("path is required")
  if (!path.isAbsolute(target)) throw new Error("path must be absolute")

  const ok = await tryOpenInExplorer(execFileAsync, target)
  res.json(dataResponse(ok))
}))

app.get("/api/v1/logs/filenames", (_req, res) => {
  res.json(dataResponse(getLogFilenames()))
})

app.delete("/api/v1/logs", wrapRoute((req, res) => {
  const filenames = Array.isArray(req.body?.filenames) ? req.body.filenames.map(String) : []
  if (!filenames.length || filenames.includes("runtime.log")) {
    clearLogLines()
  }
  res.json(dataResponse(true))
}))

app.get("/api/v1/logs/latest", (_req, res) => {
  res.json(dataResponse(getLogText()))
})

app.get("/api/v1/log/*", (req, res) => {
  const filename = String(req.params[0] || "").trim()
  if (filename && filename !== "runtime.log") {
    res.json(dataResponse(""))
    return
  }
  res.json(dataResponse(getLogText()))
})

app.get("/api/v1/memory/stats", (_req, res) => {
  const usage = process.memoryUsage()
  res.json(dataResponse({
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    uptimeSeconds: Math.round(process.uptime()),
  }))
})

app.get("/api/v1/memory/profile", (_req, res) => {
  res.status(501).json({ error: "memory profiles are not supported in Node mode" })
})

app.get("/api/v1/memory/goroutine", (_req, res) => {
  res.status(501).json({ error: "goroutine profiles are not supported in Node mode" })
})

app.get("/api/v1/memory/cpu", (_req, res) => {
  res.status(501).json({ error: "cpu profiles are not supported in Node mode" })
})

app.post("/api/v1/memory/gc", (_req, res) => {
  if (typeof global.gc === "function") {
    global.gc()
  }
  res.json(dataResponse(true))
})

app.get("/api/v1/filecache/total-size", wrapRoute(async (_req, res) => {
  const cacheDir = path.join(config.dataDir, "cache")
  const size = await getDirectorySizeBytes(cacheDir)
  res.json(dataResponse(formatBytes(size)))
}))

app.delete("/api/v1/filecache/bucket", wrapRoute((req, res) => {
  const bucket = String(req.body?.bucket || "")
  if (!bucket) {
    throw new Error("bucket is required")
  }
  const cacheDir = path.join(config.dataDir, "cache")
  fs.mkdirSync(cacheDir, { recursive: true })
  for (const filename of fs.readdirSync(cacheDir)) {
    if (!filename.startsWith(bucket)) continue
    const target = path.join(cacheDir, filename)
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
    }
  }
  res.json(dataResponse(true))
}))

app.get("/api/v1/filecache/mediastream/videofiles/total-size", wrapRoute(async (_req, res) => {
  const dir = path.join(config.dataDir, "cache", "mediastream-videofiles")
  const size = await getDirectorySizeBytes(dir)
  res.json(dataResponse(formatBytes(size)))
}))

app.delete("/api/v1/filecache/mediastream/videofiles", wrapRoute((req, res) => {
  const dir = path.join(config.dataDir, "cache", "mediastream-videofiles")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  res.json(dataResponse(true))
}))

app.get("/api/v1/extensions/list", (_req, res) => {
  res.json(dataResponse(listExtensionData(config)))
})

app.get("/api/v1/extensions/list/development", (_req, res) => {
  res.json(dataResponse(listDevelopmentModeExtensions(config)))
})

app.get("/api/v1/extensions/list/manga-provider", (_req, res) => {
  res.json(dataResponse(listMangaProviderExtensions(config)))
})

app.get("/api/v1/extensions/list/onlinestream-provider", wrapRoute(async (_req, res) => {
  res.json(dataResponse(await listRuntimeOnlinestreamProviderExtensions(config)))
}))

app.get("/api/v1/extensions/list/anime-torrent-provider", (_req, res) => {
  res.json(dataResponse(listAnimeTorrentProviderExtensions(config)))
})

app.get("/api/v1/extensions/list/custom-source", (_req, res) => {
  res.json(dataResponse(listCustomSourceExtensions(config)))
})

app.post("/api/v1/torrent/search", wrapRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const requestedProvider = String(body.provider || "").trim()
  const settings = getSettings(db)
  const fallbackProvider = String(settings?.library?.torrentProvider || "").trim()
  const installedProviders = listAnimeTorrentProviderExtensions(config)
  const providerId = requestedProvider && requestedProvider !== "none"
    ? requestedProvider
    : (fallbackProvider && fallbackProvider !== "none" ? fallbackProvider : (installedProviders[0]?.id || ""))

  if (!providerId) {
    res.json(dataResponse({
      torrents: [],
      previews: [],
      torrentMetadata: {},
      debridInstantAvailability: {},
      animeMetadata: null,
      includedSpecialProviders: [],
    }))
    return
  }

  const media = normalizeTorrentProviderMedia(body.media)
  if (body.absoluteOffset !== undefined) {
    media.absoluteSeasonOffset = Number(body.absoluteOffset || 0) || 0
  }

  const torrents = await searchAnimeTorrents(config, providerId, {
    type: body.type,
    query: body.query,
    episodeNumber: body.episodeNumber,
    batch: body.batch,
    resolution: body.resolution,
    bestRelease: body.bestRelease,
    media,
  })

  res.json(dataResponse({
    torrents,
    previews: [],
    torrentMetadata: {},
    debridInstantAvailability: {},
    animeMetadata: null,
    includedSpecialProviders: [],
  }))
}))

app.get("/api/v1/torrent-client/list", wrapRoute(async (req, res) => {
  const qb = getQbClient(db)
  if (!qb) {
    res.json(dataResponse([]))
    return
  }
  const category = req.query?.category ? String(req.query.category) : ""
  const sort = req.query?.sort ? String(req.query.sort) : ""
  const list = await qb.listTorrents({ category, sort })
  res.json(dataResponse(list))
}))

app.post("/api/v1/torrent-client/action", wrapRoute(async (req, res) => {
  const qb = getQbClient(db)
  if (!qb) {
    res.json(dataResponse(false))
    return
  }

  const body = req.body && typeof req.body === "object" ? req.body : {}
  const hash = String(body.hash || "").trim()
  const action = String(body.action || "").trim()
  const dir = String(body.dir || "").trim()
  if (!hash || !action) throw new Error("missing arguments")

  switch (action) {
    case "pause":
      await qb.pauseTorrents([hash])
      break
    case "resume":
      await qb.resumeTorrents([hash])
      break
    case "remove":
      await qb.removeTorrents([hash], { deleteFiles: false })
      break
    case "open":
      if (!dir) throw new Error("directory not found")
      break
    default:
      throw new Error("unknown action")
  }

  res.json(dataResponse(true))
}))

app.post("/api/v1/torrent-client/get-files", wrapRoute(async (req, res) => {
  const qb = getQbClient(db)
  if (!qb) {
    res.json(dataResponse([]))
    return
  }

  const body = req.body && typeof req.body === "object" ? req.body : {}
  const providerId = String(body.provider || body?.torrent?.provider || "").trim()
  const torrent = body?.torrent && typeof body.torrent === "object" ? body.torrent : null
  if (!torrent) throw new Error("torrent is required")

  let infoHash = String(torrent.infoHash || "").trim()
  if (!infoHash && providerId) {
    infoHash = await getTorrentInfoHash(config, providerId, torrent)
    torrent.infoHash = infoHash
  }
  if (!infoHash) throw new Error("torrent infoHash is required")

  const torrentstreamSettings = getTorrentstreamSettings(config)
  const allowServerTempStorage = Boolean(String(torrentstreamSettings?.downloadDir || "").trim())

  const exists = await qb.torrentExists(infoHash)
  let tempAdded = false
  if (!exists) {
    if (!allowServerTempStorage) {
      res.json(dataResponse([]))
      return
    }
    if (!providerId) throw new Error("provider is required to add torrent")
    const magnet = await getTorrentMagnetLink(config, providerId, torrent)
    if (!magnet) throw new Error("magnet link not found")
    await qb.addMagnets([magnet], "/tmp/nixer-torrent-inspect", { paused: true })
    tempAdded = true

    const startedAt = Date.now()
    while (Date.now() - startedAt < 15000) {
      if (await qb.torrentExists(infoHash)) break
      await waitMs(400)
    }
  }

  const files = await qb.getFiles(infoHash)
  const names = files.map((file) => String(file?.name || file?.path || "")).filter(Boolean)

  if (tempAdded) {
    try {
      await qb.removeTorrents([infoHash], { deleteFiles: true })
    } catch {
      // ignore cleanup errors
    }
  }

  res.json(dataResponse(names))
}))

app.post("/api/v1/torrent-client/download", wrapRoute(async (req, res) => {
  const qb = getQbClient(db)
  if (!qb) {
    res.json(dataResponse(false))
    return
  }

  const body = req.body && typeof req.body === "object" ? req.body : {}
  const torrents = Array.isArray(body.torrents) ? body.torrents : []
  const torrentstreamSettings = getTorrentstreamSettings(config)
  const settings = getSettings(db)

  const requestedDestination = String(body.destination || "").trim()
  const fallbackDownloadDir = String(torrentstreamSettings?.downloadDir || "").trim()
  const fallbackLibraryDir = String(settings?.library?.libraryPath || "").trim()
  const destination = requestedDestination || fallbackDownloadDir || fallbackLibraryDir

  if (!destination) {
    throw new Error("destination not found")
  }
  if (!path.isAbsolute(destination)) {
    throw new Error("destination path must be absolute")
  }

  const qbConfig = getQbittorrentConfigFromSettings(settings) || {}
  const magnets = []
  for (const torrent of torrents) {
    const normalized = torrent && typeof torrent === "object" ? torrent : {}
    const providerId = String(normalized.provider || "").trim()
    if (!providerId) {
      throw new Error("torrent provider is required")
    }
    const magnet = await getTorrentMagnetLink(config, providerId, normalized)
    if (!magnet) {
      throw new Error(`magnet link not found for provider=${providerId}`)
    }
    magnets.push(magnet)
  }

  await qb.addMagnets(magnets, destination, {
    category: qbConfig.category || "",
    tags: qbConfig.tags || "",
    paused: false,
  })

  res.json(dataResponse(true))
}))

app.post("/api/v1/torrent-client/rule-magnet", wrapRoute(async (req, res) => {
  const qb = getQbClient(db)
  if (!qb) {
    res.json(dataResponse(false))
    return
  }

  const body = req.body && typeof req.body === "object" ? req.body : {}
  const magnet = String(body.magnetUrl || body.magnetURL || "").trim()
  if (!magnet) throw new Error("magnetUrl is required")

  const torrentstreamSettings = getTorrentstreamSettings(config)
  const settings = getSettings(db)
  const destination = String(torrentstreamSettings?.downloadDir || "").trim() || String(settings?.library?.libraryPath || "").trim()
  if (!destination) throw new Error("destination not found")

  const qbConfig = getQbittorrentConfigFromSettings(settings) || {}
  await qb.addMagnets([magnet], destination, {
    category: qbConfig.category || "",
    tags: qbConfig.tags || "",
    paused: false,
  })

  res.json(dataResponse(true))
}))

app.get("/api/v1/anilist/collection", (_req, res) => {
  res.json(dataResponse(buildAnimeCollection(filterAnimeOnlyRows(getLocalAnimeEntries(db)))))
})

app.post("/api/v1/anilist/collection", (_req, res) => {
  res.json(dataResponse(buildAnimeCollection(filterAnimeOnlyRows(getLocalAnimeEntries(db)))))
})

app.get("/api/v1/anilist/collection/raw", (_req, res) => {
  res.json(dataResponse(buildAnimeCollection(filterAnimeOnlyRows(getLocalAnimeEntries(db)))))
})

app.post("/api/v1/anilist/collection/raw", (_req, res) => {
  res.json(dataResponse(buildAnimeCollection(filterAnimeOnlyRows(getLocalAnimeEntries(db)))))
})

app.get("/api/v1/library/collection", (req, res) => {
  const userKey = getContinuityUserKey(req)
  res.json(dataResponse(buildLibraryCollection(getLocalAnimeEntries(db), {
    continuityByMediaId: getContinuityWatchHistory(db, userKey),
  })))
})

app.post("/api/v1/library/collection", (req, res) => {
  const userKey = getContinuityUserKey(req)
  res.json(dataResponse(buildLibraryCollection(getLocalAnimeEntries(db), {
    continuityByMediaId: getContinuityWatchHistory(db, userKey),
  })))
})

app.get("/api/v1/library/explorer/file-tree", wrapRoute(async (_req, res) => {
  const settings = getSettings(db)
  const roots = resolveLibraryRoots(settings)
  const localFiles = getLocalFiles(db)
  res.json(dataResponse(buildLibraryExplorerFileTree(roots, localFiles)))
}))

app.post("/api/v1/library/explorer/file-tree/refresh", wrapRoute(async (_req, res) => {
  const settings = getSettings(db)
  const roots = resolveLibraryRoots(settings)
  const foundPaths = await scanVideoFiles(roots)

  const existing = new Map(getLocalFiles(db).map((file) => [file.path, file]))
  for (const filePath of foundPaths) {
    const previous = existing.get(filePath)
    upsertLocalFile(db, {
      path: filePath,
      name: path.basename(filePath),
      parsedInfo: previous?.parsedInfo ?? null,
      parsedFolderInfo: previous?.parsedFolderInfo ?? null,
      metadata: previous?.metadata ?? null,
      locked: Boolean(previous?.locked),
      ignored: Boolean(previous?.ignored),
      mediaId: Number(previous?.mediaId || 0) || 0,
    })
  }

  deleteLocalFilesNotIn(db, foundPaths)
  res.json(dataResponse(true))
}))

app.post("/api/v1/library/explorer/directory-children", wrapRoute(async (req, res) => {
  const directoryPath = String(req.body?.directoryPath || "").trim()
  if (!directoryPath) throw new Error("directoryPath is required")
  res.json(dataResponse(true))
}))

app.get("/api/v1/library/local-files", (_req, res) => {
  res.json(dataResponse(getLocalFiles(db)))
})

app.patch("/api/v1/library/local-file", wrapRoute((req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const filePath = String(body.path || "").trim()
  if (!filePath) throw new Error("path is required")

  const ok = updateLocalFile(db, {
    path: filePath,
    metadata: body.metadata,
    locked: Boolean(body.locked),
    ignored: Boolean(body.ignored),
    mediaId: Number(body.mediaId || 0) || 0,
  })

  if (!ok) {
    res.json(dataResponse(getLocalFiles(db)))
    return
  }
  res.json(dataResponse(getLocalFiles(db)))
}))

app.post("/api/v1/library/scan", wrapRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const skipLockedFiles = Boolean(body.skipLockedFiles)
  const skipIgnoredFiles = Boolean(body.skipIgnoredFiles)

  const settings = getSettings(db)
  const roots = resolveLibraryRoots(settings)
  const foundPaths = await scanVideoFiles(roots)

  const existing = new Map(getLocalFiles(db).map((file) => [file.path, file]))
  for (const filePath of foundPaths) {
    const previous = existing.get(filePath)
    upsertLocalFile(db, {
      path: filePath,
      name: path.basename(filePath),
      parsedInfo: previous?.parsedInfo ?? null,
      parsedFolderInfo: previous?.parsedFolderInfo ?? null,
      metadata: previous?.metadata ?? null,
      locked: Boolean(previous?.locked),
      ignored: Boolean(previous?.ignored),
      mediaId: Number(previous?.mediaId || 0) || 0,
    })
  }

  if (!skipLockedFiles && !skipIgnoredFiles) {
    deleteLocalFilesNotIn(db, foundPaths)
  }

  res.json(dataResponse(getLocalFiles(db)))
}))

app.get("/api/v1/library/scan-summaries", (_req, res) => {
  res.json(dataResponse([]))
})

app.delete("/api/v1/library/empty-directories", wrapRoute(async (_req, res) => {
  const settings = getSettings(db)
  const roots = resolveLibraryRoots(settings)

  let removed = 0
  for (const root of roots) {
    removed += await deleteEmptyDirectories(root)
  }

  res.json(dataResponse(true))
}))

app.get("/api/v1/library/schedule", (_req, res) => {
  res.json(dataResponse([]))
})

app.get("/api/v1/continuity/history", (req, res) => {
  res.json(dataResponse(getContinuityWatchHistory(db, getContinuityUserKey(req))))
})

app.get("/api/v1/continuity/item/:id", (req, res) => {
  const mediaId = Number(req.params.id)
  const userKey = getContinuityUserKey(req)
  const item = mediaId ? getContinuityWatchHistoryItem(db, userKey, mediaId) : null
  logInfo(
    "continuity",
    item
      ? `read media=${mediaId} found=true episode=${item.episodeNumber} time=${formatProgressSeconds(item.currentTime)}s duration=${formatProgressSeconds(item.duration)}s user=${userKey}`
      : `read media=${mediaId || 0} found=false user=${userKey}`,
  )
  res.json(dataResponse(item ? { found: true, item } : { found: false }))
})

app.patch("/api/v1/continuity/item", wrapRoute((req, res) => {
  const options = req.body?.options && typeof req.body.options === "object"
    ? req.body.options
    : (req.body || {})
  const mediaId = Number(options.mediaId)
  const episodeNumber = Number(options.episodeNumber)
  const userKey = getContinuityUserKey(req)

  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  if (!episodeNumber) {
    throw new Error("episodeNumber is required")
  }

  const saveResult = upsertContinuityWatchHistoryItem(db, {
    userKey,
    mediaId,
    episodeNumber,
    currentTime: Number(options.currentTime || 0),
    duration: Number(options.duration || 0),
    kind: String(options.kind || "onlinestream"),
    filepath: String(options.filepath || ""),
  })
  const savedItem = saveResult?.item || null

  logProgressSaved({
    kind: "continuity",
    mediaId,
    episodeNumber: savedItem?.episodeNumber ?? episodeNumber,
    currentTime: savedItem?.currentTime ?? Number(options.currentTime || 0),
    duration: savedItem?.duration ?? Number(options.duration || 0),
    userKey,
    status: saveResult?.ignoredRegression ? "IGNORED_ZERO_REGRESSION" : undefined,
  })

  notifySyncStateChanged("continuity", { mediaId, userKey })
  res.json(dataResponse(true))
}))

app.get("/api/v1/manga/anilist/collection", (_req, res) => {
  res.json(dataResponse(buildMangaCollection(getLocalMangaEntries(db))))
})

app.post("/api/v1/manga/anilist/collection", (_req, res) => {
  res.json(dataResponse(buildMangaCollection(getLocalMangaEntries(db))))
})

app.get("/api/v1/manga/anilist/collection/raw", (_req, res) => {
  res.json(dataResponse(buildMangaCollection(getLocalMangaEntries(db))))
})

app.post("/api/v1/manga/anilist/collection/raw", (_req, res) => {
  res.json(dataResponse(buildMangaCollection(getLocalMangaEntries(db))))
})

app.get("/api/v1/manga/collection", (_req, res) => {
  res.json(dataResponse(buildLocalMangaCollection(getLocalMangaEntries(db))))
})

app.get("/api/v1/manga/latest-chapter-numbers", (_req, res) => {
  res.json(dataResponse({}))
})

app.post("/api/v1/manga/anilist/list", wrapRoute(async (req, res) => {
  try {
    const result = await listManga(req.body || {})
    res.json(dataResponse(result))
  } catch (error) {
    logWarn("anilist", `listManga failed: ${error?.message || error}`)
    res.json(dataResponse(emptyListedAnime()))
  }
}))

app.post("/api/v1/manga/update-progress", wrapRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const options = body?.options && typeof body.options === "object" ? body.options : body

  const mediaId = Number(options.mediaId ?? options.mediaID ?? options.id ?? 0)
  const chapterNumber = Number(options.chapterNumber ?? options.progress ?? 0)
  const totalChapters = Number(options.totalChapters ?? options.chapters ?? 0)
  if (!mediaId) throw new Error("mediaId is required")

  const existing = getLocalMangaEntry(db, mediaId)
  let media = null
  if (existing?.media_json) {
    try { media = JSON.parse(existing.media_json) } catch { media = null }
  }
  if (!media) {
    try {
      media = await getMangaDetails(mediaId)
    } catch (error) {
      logWarn("anilist", `getMangaDetails failed for manga/update-progress mediaId=${mediaId}: ${error?.message || error}`)
      media = buildPlaceholderMangaMedia(mediaId)
    }
  }

  const safeChapterNumber = Math.max(0, chapterNumber)
  const safeTotal = Math.max(0, totalChapters || Number(media?.chapters || 0))
  const status = safeTotal > 0 && safeChapterNumber >= safeTotal
    ? "COMPLETED"
    : (safeChapterNumber > 0 ? "CURRENT" : "PLANNING")

  upsertLocalMangaEntry(db, {
    media_id: mediaId,
    media_json: JSON.stringify(media),
    status,
    progress: safeChapterNumber,
    score: Number(existing?.score || 0),
    repeat_count: Number(existing?.repeat_count || 0),
    started_at: existing?.started_at || (safeChapterNumber > 0 ? new Date().toISOString() : null),
    completed_at: status === "COMPLETED" ? (existing?.completed_at || new Date().toISOString()) : null,
    created_at: existing?.created_at
  })

  notifySyncStateChanged("manga-list", { mediaId })
  res.json(dataResponse(true))
}))

app.get("/api/v1/manga/entry/:id", wrapRoute(async (req, res) => {
  const mediaId = Number(req.params.id)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  let media = null
  try {
    media = await getMangaDetails(mediaId)
  } catch (error) {
    logWarn("anilist", `getMangaDetails failed for mediaId=${mediaId}: ${error?.message || error}`)
    media = buildPlaceholderMangaMedia(mediaId)
  }
  res.json(dataResponse({
    mediaId,
    media,
    listData: {
      progress: 0,
      score: 0,
      status: null,
      repeat: 0,
      startedAt: "",
      completedAt: "",
    }
  }))
}))

app.get("/api/v1/manga/entry/:id/details", wrapRoute(async (req, res) => {
  const mediaId = Number(req.params.id)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }
  try {
    res.json(dataResponse(await getMangaDetails(mediaId)))
  } catch (error) {
    logWarn("anilist", `getMangaDetails failed for mediaId=${mediaId}: ${error?.message || error}`)
    res.json(dataResponse(buildPlaceholderMangaMedia(mediaId)))
  }
}))

app.post("/api/v1/manga/search", wrapRoute(async (req, res) => {
  const provider = String(req.body?.provider || "").trim()
  const query = String(req.body?.query || "").trim()
  if (!provider) throw new Error("provider is required")
  res.json(dataResponse(await searchManga(config, provider, query)))
}))

app.post("/api/v1/manga/manual-mapping", wrapRoute((req, res) => {
  const provider = String(req.body?.provider || "").trim()
  const mediaId = Number(req.body?.mediaId || 0)
  const mangaId = String(req.body?.mangaId || "").trim()
  upsertMangaMapping(db, provider, mediaId, mangaId)
  res.json(dataResponse(true))
}))

app.post("/api/v1/manga/get-mapping", wrapRoute((req, res) => {
  const provider = String(req.body?.provider || "").trim()
  const mediaId = Number(req.body?.mediaId || 0)
  const mapping = getMangaMapping(db, provider, mediaId)
  res.json(dataResponse(mapping ? { mangaId: mapping } : {}))
}))

app.post("/api/v1/manga/remove-mapping", wrapRoute((req, res) => {
  const provider = String(req.body?.provider || "").trim()
  const mediaId = Number(req.body?.mediaId || 0)
  deleteMangaMapping(db, provider, mediaId)
  res.json(dataResponse(true))
}))

app.post("/api/v1/manga/chapters", wrapRoute(async (req, res) => {
  const provider = String(req.body?.provider || "").trim()
  const mediaId = Number(req.body?.mediaId || 0)
  if (!provider) throw new Error("provider is required")
  if (!mediaId) throw new Error("mediaId is required")

  let mangaId = getMangaMapping(db, provider, mediaId)
  if (!mangaId) {
    const media = await getMangaDetails(mediaId).catch(() => null)
    const candidateQueries = [
      media?.title?.english,
      media?.title?.romaji,
      media?.title?.native,
      media?.title?.userPreferred,
    ].map((value) => String(value || "").trim()).filter(Boolean)

    for (const query of candidateQueries) {
      const results = await searchManga(config, provider, query).catch(() => [])
      if (!results.length) continue
      const best = pickBestMangaSearchResult(query, results)
      if (!best?.id) continue
      mangaId = best.id
      upsertMangaMapping(db, provider, mediaId, mangaId)
      break
    }
  }

  if (!mangaId) {
    res.json(dataResponse({ mediaId, provider, chapters: [] }))
    return
  }

  const chapters = await findMangaChapters(config, provider, mangaId)
  chapters.sort((a, b) => Number(a.index) - Number(b.index))
  res.json(dataResponse({
    mediaId,
    provider,
    chapters
  }))
}))

app.post("/api/v1/manga/pages", wrapRoute(async (req, res) => {
  const provider = String(req.body?.provider || "").trim()
  const mediaId = Number(req.body?.mediaId || 0)
  const chapterId = String(req.body?.chapterId || "").trim()
  if (!provider) throw new Error("provider is required")
  if (!mediaId) throw new Error("mediaId is required")
  if (!chapterId) throw new Error("chapterId is required")

  const pages = await findMangaChapterPages(config, provider, chapterId)
  pages.sort((a, b) => Number(a.index) - Number(b.index))
  res.json(dataResponse({
    mediaId,
    provider,
    chapterId,
    pages: pages.map((page) => ({
      ...page,
      headers: Object.fromEntries(Object.entries(page.headers || {}).map(([key, value]) => [String(key), String(value)]))
    })),
    pageDimensions: {},
    isDownloaded: false
  }))
}))

app.post("/api/v1/manga/download-data", wrapRoute((req, res) => {
  const mediaId = Number(req.body?.mediaId || 0)
  if (!mediaId) throw new Error("mediaId is required")
  res.json(dataResponse({
    downloaded: {},
    queued: {}
  }))
}))

app.get("/api/v1/manga/download-queue", (_req, res) => {
  res.json(dataResponse([]))
})

app.post("/api/v1/extensions/all", (_req, res) => {
  res.json(dataResponse(getAllExtensions(config)))
})

app.post("/api/v1/anilist/list-anime", wrapRoute(async (req, res) => {
  const result = await listAnime(req.body || {})
  res.json(dataResponse(result))
}))

app.post("/api/v1/anilist/list-recent-anime", wrapRoute(async (req, res) => {
  const result = await listRecentAnime(req.body || {})
  res.json(dataResponse(result))
}))

app.get("/api/v1/library/missing-episodes", (_req, res) => {
  res.json(dataResponse(buildMissingEpisodes(getLocalAnimeEntries(db))))
})

app.get("/api/v1/local/track/:id/:type", (_req, res) => {
  res.json(dataResponse(false))
})

app.get("/api/v1/auto-downloader/items", (_req, res) => {
  res.json(dataResponse([]))
})

app.get("/api/v1/nakama/room/available", (_req, res) => {
  res.json(dataResponse(false))
})

app.get("/api/v1/extensions/plugin-settings", (_req, res) => {
  res.json(dataResponse(getPluginSettings(config)))
})

app.post("/api/v1/extensions/plugin-settings/pinned-trays", (req, res) => {
  const current = getPluginSettings(config)
  savePluginSettings(config, {
    ...current,
    pinnedTrayPluginIds: Array.isArray(req.body?.pinnedTrayPluginIds) ? req.body.pinnedTrayPluginIds : []
  })
  res.json(dataResponse(true))
})

app.get("/api/v1/latest-update", (_req, res) => {
  res.json(dataResponse({
    type: "none",
    current_version: config.version
  }))
})

app.get("/api/v1/extensions/updates", (_req, res) => {
  res.json(dataResponse([]))
})

app.get("/api/v1/extensions/marketplace", wrapRoute(async (req, res) => {
  const marketplace = await getMarketplaceExtensions(config, req.query.marketplace)
  res.json(dataResponse(marketplace))
}))

app.post("/api/v1/extensions/external/fetch", wrapRoute(async (req, res) => {
  const manifestUri = String(req.body?.manifestUri || "").trim()
  res.json(dataResponse(await fetchExternalExtensionData(manifestUri)))
}))

app.post("/api/v1/extensions/external/install", wrapRoute(async (req, res) => {
  const manifestUri = String(req.body?.manifestUri || "").trim()
  const { response } = await installExternalExtension(config, manifestUri)
  res.json(dataResponse(response))
}))

app.post("/api/v1/extensions/external/install-repository", wrapRoute(async (req, res) => {
  const repositoryUri = String(req.body?.repositoryUri || "").trim()
  const install = Boolean(req.body?.install)
  res.json(dataResponse(await installExternalExtensionRepository(config, repositoryUri, install)))
}))

app.post("/api/v1/extensions/external/uninstall", wrapRoute((req, res) => {
  const id = String(req.body?.id || "").trim()
  uninstallExternalExtension(config, id)
  res.json(dataResponse(true))
}))

app.get("/api/v1/extensions/payload/:id", wrapRoute((req, res) => {
  res.json(dataResponse(getExtensionPayload(config, req.params.id)))
}))

app.post("/api/v1/extensions/external/edit-payload", wrapRoute((req, res) => {
  updateExtensionCode(config, String(req.body?.id || "").trim(), String(req.body?.payload || ""))
  res.json(dataResponse(true))
}))

app.post("/api/v1/extensions/external/reload", (_req, res) => {
  res.json(dataResponse(true))
})

app.post("/api/v1/extensions/plugin-permissions/grant", wrapRoute((req, res) => {
  const id = String(req.body?.id || "").trim()
  res.json(dataResponse(grantPluginPermissions(config, id)))
}))

app.get("/api/v1/extensions/user-config/:id", wrapRoute((req, res) => {
  res.json(dataResponse(getExtensionUserConfig(config, req.params.id)))
}))

app.post("/api/v1/extensions/user-config", wrapRoute((req, res) => {
  const id = String(req.body?.id || "").trim()
  const version = Number(req.body?.version || 0)
  const values = req.body?.values
  res.json(dataResponse(saveExtensionUserConfig(config, id, version, values)))
}))

app.get("/api/v1/anilist/stats", (_req, res) => {
  res.json(dataResponse(buildLocalStats(getLocalAnimeEntries(db))))
})

app.get("/api/v1/anilist/media-details/:id", wrapRoute(async (req, res) => {
  try {
    const media = await getAnimeDetails(req.params.id)
    res.json(dataResponse(media))
  } catch (error) {
    logWarn("anilist", `media-details failed for id=${Number(req.params.id) || 0}: ${error?.message || error}`)
    res.json(dataResponse(null))
  }
}))

app.post("/api/v1/anilist/list-entry", wrapRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const options = body?.options && typeof body.options === "object" ? body.options : body
  const mediaId = Number(
    options.mediaId ??
    options.mediaID ??
    options.id ??
    options?.media?.id ??
    0
  )
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  const entryTypeRaw = String(options.type || options?.media?.type || "").trim().toLowerCase()
  const entryType = entryTypeRaw === "manga" || entryTypeRaw === "anime" ? entryTypeRaw : ""
  const existingAnime = getLocalAnimeEntry(db, mediaId)
  const existingManga = getLocalMangaEntry(db, mediaId)

  const shouldHandleManga = entryType === "manga" || (!entryType && Boolean(existingManga) && !existingAnime)
  const shouldHandleAnime = entryType === "anime" || (!entryType && !shouldHandleManga)

  let media = null
  if (shouldHandleManga && existingManga?.media_json) {
    try { media = JSON.parse(existingManga.media_json) } catch { media = null }
  }
  if (shouldHandleAnime && existingAnime?.media_json) {
    try { media = JSON.parse(existingAnime.media_json) } catch { media = null }
  }

  if (!media) {
    try {
      media = shouldHandleManga ? await getMangaDetails(mediaId) : await getAnimeDetails(mediaId)
    } catch (error) {
      logWarn("anilist", `getMediaDetails failed for mediaId=${mediaId} type=${shouldHandleManga ? "manga" : "anime"}: ${error?.message || error}`)
      media = shouldHandleManga ? buildPlaceholderMangaMedia(mediaId) : buildPlaceholderAnimeMedia(mediaId)
    }
  }
  if (!media) {
    throw new Error("anime not found")
  }

  const mediaType = String(media?.type || "").trim().toUpperCase()
  const isMangaMedia = mediaType === "MANGA"
  const isAnimeMedia = mediaType === "ANIME"

  const hasProgress = Object.prototype.hasOwnProperty.call(options, "progress")
  const hasStatus = Object.prototype.hasOwnProperty.call(options, "status")
  const hasScore = Object.prototype.hasOwnProperty.call(options, "score")
  const hasRepeat = Object.prototype.hasOwnProperty.call(options, "repeat")
  const hasStartedAt = Object.prototype.hasOwnProperty.call(options, "startedAt")
  const hasCompletedAt = Object.prototype.hasOwnProperty.call(options, "completedAt")

  const progress = hasProgress
    ? Number(options.progress ?? 0)
    : Number((shouldHandleManga ? existingManga : existingAnime)?.progress ?? 0)

  const inferredStatus = (() => {
    if (shouldHandleManga) {
      const totalChapters = Number(media?.chapters || 0)
      if (totalChapters > 0 && progress >= totalChapters) return "COMPLETED"
      if (progress > 0) return "CURRENT"
      return "PLANNING"
    }

    const totalEpisodes = Number(media?.episodes || 0)
    return inferStatus(progress, totalEpisodes, existingAnime?.status)
  })()

  const status = hasStatus
    ? String(options.status || inferredStatus)
    : String((shouldHandleManga ? existingManga : existingAnime)?.status || inferredStatus)
  const score = hasScore ? Number(options.score ?? 0) : Number((shouldHandleManga ? existingManga : existingAnime)?.score ?? 0)
  const repeatCount = hasRepeat ? Number(options.repeat ?? 0) : Number((shouldHandleManga ? existingManga : existingAnime)?.repeat_count ?? 0)
  const startedAt = hasStartedAt
    ? (fuzzyDateToIso(options.startedAt) || null)
    : ((shouldHandleManga ? existingManga : existingAnime)?.started_at || autoStartedAt(progress))
  const completedAt = hasCompletedAt
    ? (fuzzyDateToIso(options.completedAt) || null)
    : (
      status === "COMPLETED"
        ? ((shouldHandleManga ? existingManga : existingAnime)?.completed_at || autoCompletedAt(status))
        : (hasStatus ? null : ((shouldHandleManga ? existingManga : existingAnime)?.completed_at || null))
    )

  if (shouldHandleManga || isMangaMedia) {
    // Ensure manga entries never show up in the anime "My Lists".
    if (existingAnime) {
      deleteLocalAnimeEntry(db, mediaId)
    }
    upsertLocalMangaEntry(db, {
      media_id: mediaId,
      media_json: JSON.stringify(media),
      status,
      progress,
      score,
      repeat_count: repeatCount,
      started_at: startedAt,
      completed_at: completedAt,
      created_at: existingManga?.created_at
    })
    logInfo("anilist", `saved local manga entry mediaId=${mediaId} status=${status} progress=${progress}`)
    notifySyncStateChanged("manga-list", { mediaId })
  } else if (shouldHandleAnime || isAnimeMedia) {
    // Ensure anime entries never end up in the manga list.
    if (existingManga) {
      deleteLocalMangaEntry(db, mediaId)
    }
    upsertLocalAnimeEntry(db, {
      media_id: mediaId,
      media_json: JSON.stringify(media),
      status,
      progress,
      score,
      repeat_count: repeatCount,
      started_at: startedAt,
      completed_at: completedAt,
      created_at: existingAnime?.created_at
    })
    logInfo("anilist", `saved local anime entry mediaId=${mediaId} status=${status} progress=${progress}`)
    notifySyncStateChanged("anime-list", { mediaId })
  } else {
    // Unknown media types are ignored.
    res.json(dataResponse(true))
    return
  }

  res.json(dataResponse(true))
}))

app.delete("/api/v1/anilist/list-entry", wrapRoute((req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const options = body?.options && typeof body.options === "object" ? body.options : body
  const mediaId = Number(
    options.mediaId ??
    options.mediaID ??
    options.id ??
    options?.media?.id ??
    0
  )
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  const entryType = String(options.type || options?.media?.type || "").trim().toLowerCase()
  if (entryType === "manga") {
    deleteLocalMangaEntry(db, mediaId)
  } else if (entryType === "anime") {
    deleteLocalAnimeEntry(db, mediaId)
  } else {
    deleteLocalAnimeEntry(db, mediaId)
    deleteLocalMangaEntry(db, mediaId)
  }
  notifySyncStateChanged("anime-list", { mediaId })
  res.json(dataResponse(true))
}))

app.post("/api/v1/library/unknown-media", wrapRoute(async (req, res) => {
  const mediaIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds.map(Number).filter(Boolean) : []
  for (const mediaId of mediaIds) {
    const existing = getLocalAnimeEntry(db, mediaId)
    if (existing) continue
    let media = null
    try {
      media = await getAnimeDetails(mediaId)
    } catch (error) {
      logWarn("anilist", `getAnimeDetails failed for unknown-media mediaId=${mediaId}: ${error?.message || error}`)
      media = buildPlaceholderAnimeMedia(mediaId)
    }
    if (!media) continue
    upsertLocalAnimeEntry(db, {
      media_id: mediaId,
      media_json: JSON.stringify(media),
      status: "PLANNING",
      progress: 0,
      score: 0,
      repeat_count: 0
    })
  }

  if (mediaIds.length) {
    notifySyncStateChanged("anime-list", { mediaIds })
  }
  res.json(dataResponse(buildAnimeCollection(getLocalAnimeEntries(db))))
}))

app.get("/api/v1/metadata/parent/:id", (_req, res) => {
  res.json(dataResponse(null))
})

app.post("/api/v1/metadata/parent", (_req, res) => {
  res.json(dataResponse(true))
})

app.delete("/api/v1/metadata/parent", (_req, res) => {
  res.json(dataResponse(true))
})

app.get("/api/v1/library/anime-entry/:id", wrapRoute(async (req, res) => {
  const row = getLocalAnimeEntry(db, Number(req.params.id))
  const continuity = getContinuityWatchHistoryItem(db, getContinuityUserKey(req), Number(req.params.id))
  if (row) {
    res.json(dataResponse(buildAnimeEntry(row, { continuity })))
    return
  }

  let media = null
  try {
    media = await getAnimeDetails(req.params.id)
  } catch (error) {
    logWarn("anilist", `getAnimeDetails failed for library/anime-entry id=${Number(req.params.id) || 0}: ${error?.message || error}`)
    media = buildPlaceholderAnimeMedia(Number(req.params.id) || 0)
  }

  res.json(dataResponse(media ? buildRemoteAnimeEntry(media, { continuity }) : null))
}))

app.get("/api/v1/anime/episode-collection/:id", wrapRoute(async (req, res) => {
  const media = await getAnimeDetails(req.params.id)
  if (!media) {
    throw new Error("anime not found")
  }

  res.json(dataResponse(buildEpisodeCollection(media, {
    continuity: getContinuityWatchHistoryItem(db, getContinuityUserKey(req), Number(req.params.id))
  })))
}))

app.post("/api/v1/library/anime-entry/update-progress", wrapRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const options = body?.options && typeof body.options === "object" ? body.options : body
  const mediaId = Number(options.mediaId ?? options.mediaID ?? options.id ?? 0)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  const row = getLocalAnimeEntry(db, mediaId)
  const media = row ? JSON.parse(row.media_json) : await getAnimeDetails(mediaId)
  if (!media) {
    throw new Error("anime not found")
  }

  const progress = Number(options.episodeNumber || 0)
  const totalEpisodes = Number(options.totalEpisodes || media?.episodes || 0)
  const status = inferStatus(progress, totalEpisodes, row?.status)

  upsertLocalAnimeEntry(db, {
    media_id: mediaId,
    media_json: JSON.stringify(media),
    progress,
    status,
    score: Number(row?.score || 0),
    repeat_count: Number(row?.repeat_count || 0),
    started_at: row?.started_at || autoStartedAt(progress),
    completed_at: status === "COMPLETED" ? row?.completed_at || new Date().toISOString() : null,
    created_at: row?.created_at
  })

  logProgressSaved({
    kind: "anime-entry",
    mediaId,
    episodeNumber: progress,
    totalEpisodes,
    status,
  })

  notifySyncStateChanged("anime-list", { mediaId })
  res.json(dataResponse(true))
}))

app.post("/api/v1/library/anime-entry/update-repeat", wrapRoute((req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const options = body?.options && typeof body.options === "object" ? body.options : body
  const mediaId = Number(options.mediaId ?? options.mediaID ?? options.id ?? 0)
  const row = getLocalAnimeEntry(db, mediaId)
  if (!row) {
    throw new Error("anime entry not found")
  }

  upsertLocalAnimeEntry(db, {
    ...row,
    media_id: row.media_id,
    media_json: row.media_json,
    repeat_count: Number(options.repeat || 0)
  })

  notifySyncStateChanged("anime-list", { mediaId })
  res.json(dataResponse(true))
}))

app.post("/api/v1/onlinestream/episode-list", wrapRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const mediaId = Number(body.mediaId ?? body.mediaID ?? body.id ?? 0)
  const provider = String(body.provider || "").trim()
  const dubbed = parseBoolean(body.dubbed)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  try {
    res.json(dataResponse(await getOnlineStreamEpisodeList(config, mediaId, provider, dubbed)))
  } catch (error) {
    logWarn("onlinestream", `episode-list failed mediaId=${mediaId} provider=${provider || "none"}: ${error?.message || error}`)
    res.json(dataResponse({ media: buildPlaceholderAnimeMedia(mediaId), episodes: [] }))
  }
}))

app.post("/api/v1/onlinestream/episode-source", wrapRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {}
  const mediaId = Number(body.mediaId ?? body.mediaID ?? body.id ?? 0)
  const provider = String(body.provider || "").trim()
  const dubbed = parseBoolean(body.dubbed)
  const episodeNumber = Number(body.episodeNumber)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }
  if (!provider) {
    throw new Error("provider is required")
  }
  if (!episodeNumber) {
    throw new Error("episodeNumber is required")
  }

  try {
    res.json(dataResponse(await getOnlineStreamEpisodeSource(config, mediaId, provider, episodeNumber, dubbed)))
  } catch (error) {
    logWarn("onlinestream", `episode-source failed mediaId=${mediaId} provider=${provider}: ${error?.message || error}`)
    res.json(dataResponse({ number: episodeNumber, videoSources: [] }))
  }
}))

app.head("/api/v1/proxy", wrapRoute(async (req, res) => {
  await handleVideoProxy(req, res, true)
}))

app.get("/api/v1/proxy", wrapRoute(async (req, res) => {
  await handleVideoProxy(req, res, false)
}))

app.post("/api/v1/directstream/subs/convert-subs", wrapRoute(async (req, res) => {
  const url = String(req.body?.url || "").trim()
  const content = typeof req.body?.content === "string" ? req.body.content : ""
  const to = String(req.body?.to || "").trim().toLowerCase()

  if (!url && !content) {
    throw new Error("url or content is required")
  }

  if (!to) {
    throw new Error("to is required")
  }

  const sourceContent = content || await fetchTextContent(url)
  res.json(dataResponse(convertSubtitleContent(sourceContent, to)))
}))

app.delete("/api/v1/onlinestream/cache", (_req, res) => {
  res.json(dataResponse(true))
})

app.post("/api/v1/start", wrapRoute((req, res) => {
  const current = getSettings(db)
  const next = normalizeSettings({ ...current, ...req.body })
  saveSettings(db, next)
  ws.sendEvent("settings", next)
  notifySyncStateChanged("settings")
  res.json(dataResponse(getStatus({ db, config, req })))
}))

app.patch("/api/v1/settings", wrapRoute((req, res) => {
  const current = getSettings(db)
  const next = normalizeSettings(mergeNested(current, req.body))
  saveSettings(db, next)
  ws.sendEvent("settings", next)
  notifySyncStateChanged("settings")
  res.json(dataResponse(getStatus({ db, config, req })))
}))

app.post("/api/v1/auth/register", wrapRoute(async (req, res) => {
  const body = req.body || {}
  const username = String(body.username || "").trim()
  const email = String(body.email || "").trim().toLowerCase()
  const password = String(body.password || "")
  const avatarData = String(body.avatarData || "").trim()

  if (!username) throw new Error("username is required")
  if (!email.includes("@")) throw new Error("a valid email is required")
  if (password.length < 6) throw new Error("password must be at least 6 characters")

  const existing = getAccount(db)
  if (existing?.email && existing.email !== email) {
    throw new Error("a local account is already registered on this server")
  }
  if (existing?.email === email) {
    throw new Error("a local account already exists, please sign in")
  }

  const avatarPath = saveAvatarDataUrl(avatarData, config)
  const viewer = newLocalUser(username, avatarPath)
  const passwordHash = await bcrypt.hash(password, 10)

  saveAccount(db, {
    username,
    email,
    password_hash: passwordHash,
    avatar_path: avatarPath,
    token: LOCAL_USER_TOKEN,
    viewer_json: JSON.stringify(viewer),
    is_active: 1
  })

  res.cookie("nixer_user_token", LOCAL_USER_TOKEN, {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  })
  if (!req.cookies) req.cookies = {}
  req.cookies["nixer_user_token"] = LOCAL_USER_TOKEN

  notifySyncStateChanged("account")
  res.json(dataResponse(getStatus({ db, config, req })))
}))

app.post("/api/v1/auth/login", wrapRoute(async (req, res) => {
  const body = req.body || {}
  const email = String(body.email || "").trim().toLowerCase()
  const password = String(body.password || "")
  const account = getAccount(db)

  if (!account?.email || !account?.password_hash) {
    throw new Error("no local account registered yet")
  }
  if (account.email !== email) {
    throw new Error("invalid email or password")
  }

  const ok = await bcrypt.compare(password, account.password_hash)
  if (!ok) {
    throw new Error("invalid email or password")
  }

  saveAccount(db, {
    ...account,
    is_active: 1
  })

  res.cookie("nixer_user_token", account.token, {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  })
  if (!req.cookies) req.cookies = {}
  req.cookies["nixer_user_token"] = account.token

  notifySyncStateChanged("account")
  res.json(dataResponse(getStatus({ db, config, req })))
}))

app.post("/api/v1/auth/logout", wrapRoute((req, res) => {
  const account = getAccount(db)
  if (account) {
    saveAccount(db, { ...account, is_active: 0 })
  }
  res.clearCookie("nixer_user_token", { path: "/" })
  if (req.cookies) {
    delete req.cookies["nixer_user_token"]
  }
  notifySyncStateChanged("account")
  res.json(dataResponse(getStatus({ db, config, req })))
}))

app.post("/api/v1/auth/update", wrapRoute(async (req, res) => {
  const account = getAccount(db)
  if (!account) throw new Error("no account found")

  const token = req.cookies?.["nixer_user_token"]
  if (token !== account.token) throw new Error("unauthorized")

  const body = req.body || {}
  const username = String(body.username || "").trim()
  const avatarData = String(body.avatarData || "").trim()
  const viewer = JSON.parse(account.viewer_json || "{}")
  const nextUsername = username || String(account.username || "").trim()
  if (!nextUsername) throw new Error("username is required")

  if (!viewer.viewer || typeof viewer.viewer !== "object") {
    viewer.viewer = {}
  }

  viewer.viewer.name = nextUsername

  let nextAvatarPath = String(account.avatar_path || "")
  if (avatarData) {
    nextAvatarPath = saveAvatarDataUrl(avatarData, config)
    viewer.viewer.avatar = { medium: nextAvatarPath, large: nextAvatarPath }
  } else if (nextAvatarPath) {
    viewer.viewer.avatar = { medium: nextAvatarPath, large: nextAvatarPath }
  }

  saveAccount(db, {
    ...account,
    username: nextUsername,
    avatar_path: nextAvatarPath,
    viewer_json: JSON.stringify(viewer)
  })

  notifySyncStateChanged("account")
  res.json(dataResponse(getStatus({ db, config, req })))
}))

const generatedStubResult = registerGeneratedApiStubs(app, {
  enabled: true,
  log: (message) => logWarn("stubs", message),
})
if (generatedStubResult.registered) {
  logInfo("stubs", `registered ${generatedStubResult.registered} generated API stubs`)
}

app.use("/api/v1", (req, res) => {
  if (req.method === "HEAD") {
    res.status(200).end()
    return
  }
  logWarn("stub", `${req.method} ${req.originalUrl}`)
  res.json(dataResponse(getStubPayload(req)))
})

app.use((error, req, res, _next) => {
  logError("http", `${req.method} ${req.originalUrl}`, error?.stack || error)

  if (res.headersSent) {
    return
  }

  const status = Number.isInteger(error?.status) ? error.status : 500
  res.status(status).json({
    error: error?.message || "Internal server error"
  })
})

app.get("*", (req, res) => {
  res.sendFile(path.join(config.publicDir, "index.html"))
})

const server = http.createServer(app)
const ws = attachWebsocket(server, config)

server.listen(config.port, config.host, () => {
  logInfo("app", `NixerNodeFull listening on http://${config.host}:${config.port}`)
})

function logRequestSummary({ label, method, url, statusCode, durationMs }) {
  const now = Date.now()
  const bucketKey = `${label}:${method}:${url}:${statusCode}`
  const previous = recentRequestBuckets.get(bucketKey)

  if (previous && (now - previous.lastSeenAt) <= REQUEST_LOG_WINDOW_MS) {
    previous.count += 1
    previous.lastSeenAt = now
    previous.lastDurationMs = durationMs

    clearTimeout(previous.flushTimer)
    previous.flushTimer = setTimeout(() => {
      flushRequestBucket(bucketKey)
    }, REQUEST_LOG_WINDOW_MS)
    return
  }

  if (previous) {
    flushRequestBucket(bucketKey)
  }

  const flushTimer = setTimeout(() => {
    flushRequestBucket(bucketKey)
  }, REQUEST_LOG_WINDOW_MS)

  recentRequestBuckets.set(bucketKey, {
    label,
    method,
    url,
    statusCode,
    count: 1,
    lastSeenAt: now,
    lastDurationMs: durationMs,
    flushTimer
  })
}

function flushRequestBucket(bucketKey) {
  const bucket = recentRequestBuckets.get(bucketKey)
  if (!bucket) return

  clearTimeout(bucket.flushTimer)
  recentRequestBuckets.delete(bucketKey)

  const suffix = bucket.count > 1 ? ` x${bucket.count}` : ""
  logInfo(bucket.label.toLowerCase(), `${bucket.method} ${bucket.url} -> ${bucket.statusCode} (${bucket.lastDurationMs}ms)${suffix}`)
}

function notifySyncStateChanged(scope, detail = {}) {
  ws.sendEvent("sync-state-changed", {
    scope: String(scope || "unknown"),
    timestamp: new Date().toISOString(),
    ...detail,
  })
}

function buildDesktopSyncExport({ db, config, req }) {
  return {
    exportedAt: new Date().toISOString(),
    status: getStatus({ db, config, req }),
    settings: getSettings(db),
    theme: getTheme(db),
    collection: buildAnimeCollection(filterAnimeOnlyRows(getLocalAnimeEntries(db))),
    continuity: getContinuityWatchHistory(db, getContinuityUserKey(req)),
  }
}

function importDesktopSyncPayload({ db, config, req, payload }) {
  const state = payload && typeof payload === "object" ? payload : {}
  const settingsResponse = state.settings || {}
  const themeResponse = state.theme || {}
  const collectionResponse = state.collection || null
  const continuityResponse = state.continuity || null

  const rows = extractDesktopSyncAnimeRows(collectionResponse)
  const continuityItems = extractDesktopSyncContinuityItems(continuityResponse, getContinuityUserKey(req))

  const applyImport = db.transaction(() => {
    saveSettings(db, normalizeSettings(settingsResponse || {}))
    saveTheme(db, themeResponse || {})

    db.prepare("DELETE FROM local_anime_entries").run()
    db.prepare("DELETE FROM continuity_watch_history WHERE user_key = ?").run(getContinuityUserKey(req))

    for (const row of rows) {
      upsertLocalAnimeEntry(db, row)
    }

    for (const item of continuityItems) {
      upsertContinuityWatchHistoryItem(db, item)
    }
  })

  applyImport()

  return {
    importedAt: new Date().toISOString(),
    settingsSynced: Boolean(settingsResponse),
    themeSynced: Boolean(themeResponse),
    entriesSynced: rows.length,
    continuityItemsSynced: continuityItems.length,
    status: getStatus({ db, config, req }),
  }
}

function extractDesktopSyncAnimeRows(collectionResponse) {
  const lists = collectionResponse?.MediaListCollection?.lists
  if (!Array.isArray(lists)) {
    return []
  }

  const rows = []

  for (const list of lists) {
    const entries = Array.isArray(list?.entries) ? list.entries : []
    for (const entry of entries) {
      const mediaId = Number(entry?.media?.id || entry?.id || 0)
      if (!mediaId || !entry?.media) continue

      rows.push({
        media_id: mediaId,
        media_json: JSON.stringify(entry.media),
        status: String(entry.status || list?.status || "PLANNING"),
        progress: Number(entry.progress || 0),
        score: Number(entry.score || 0),
        repeat_count: Number(entry.repeat || 0),
        started_at: fuzzyDateToIso(entry.startedAt),
        completed_at: fuzzyDateToIso(entry.completedAt),
      })
    }
  }

  return rows
}

function extractDesktopSyncContinuityItems(continuityResponse, userKey) {
  const values = continuityResponse && typeof continuityResponse === "object"
    ? Object.values(continuityResponse)
    : []

  return values
    .map((item) => ({
      userKey,
      mediaId: Number(item?.mediaId || 0),
      kind: String(item?.kind || "onlinestream"),
      filepath: String(item?.filepath || ""),
      episodeNumber: Number(item?.episodeNumber || 0),
      currentTime: Number(item?.currentTime || 0),
      duration: Number(item?.duration || 0),
    }))
    .filter((item) => item.mediaId > 0)
}

function logProgressSaved({ kind, mediaId, episodeNumber, currentTime, duration, totalEpisodes, status, userKey }) {
  const parts = [
    `media=${Number(mediaId) || 0}`,
    `episode=${Number(episodeNumber) || 0}`,
  ]

  if (currentTime !== undefined) {
    parts.push(`time=${formatProgressSeconds(currentTime)}s`)
  }
  if (duration !== undefined) {
    parts.push(`duration=${formatProgressSeconds(duration)}s`)
  }
  if (totalEpisodes !== undefined) {
    parts.push(`total=${Number(totalEpisodes) || 0}`)
  }
  if (status) {
    parts.push(`status=${String(status)}`)
  }
  if (userKey) {
    parts.push(`user=${String(userKey)}`)
  }

  logInfo("progress", `${kind} saved ${parts.join(" ")}`)
}

function formatProgressSeconds(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number.toFixed(1) : "0.0"
}

function normalizeSettings(settings) {
  const copy = structuredClone(settings)
  copy.id = 1
  copy.updatedAt = new Date().toISOString()
  copy.library ||= {}
  copy.library.libraryPaths ||= []
  if (!Array.isArray(copy.library.libraryPaths)) {
    copy.library.libraryPaths = []
  }
  copy.library.includeOnlineStreamingInLibrary = Boolean(
    copy.library.includeOnlineStreamingInLibrary ?? copy.library.enableOnlinestream
  )
  return copy
}

function mergeNested(base, patch) {
  const output = structuredClone(base)
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object") {
      output[key] = mergeNested(output[key], value)
    } else {
      output[key] = value
    }
  }
  return output
}

function saveAvatarDataUrl(value, config) {
  if (!value) return ""

  const match = value.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/)
  if (!match) throw new Error("avatar must be a base64 data URL")

  const [, contentType, base64] = match
  const buffer = Buffer.from(base64, "base64")
  if (!buffer.length) throw new Error("avatar image is empty")

  const ext = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif"
  }[contentType]

  if (!ext) throw new Error("avatar image must be png, jpg, webp or gif")

  fs.mkdirSync(config.uploadsDir, { recursive: true })
  const filename = `local-user-avatar-${Date.now()}${ext}`
  fs.writeFileSync(path.join(config.uploadsDir, filename), buffer)
  return `/assets/profiles/${filename}`
}

function getStubPayload(req) {
  const { method, path: requestPath } = req

  if (method === "GET") {
    if (requestPath.includes("/logs/latest") || requestPath.includes("/log/")) {
      return ""
    }
    if (
      requestPath.includes("/list") ||
      requestPath.includes("/logs/filenames") ||
      requestPath.includes("/scan-summaries") ||
      requestPath.includes("/downloads") ||
      requestPath.includes("/items") ||
      requestPath.includes("/profiles") ||
      requestPath.includes("/rules")
    ) {
      return []
    }

    if (
      requestPath.includes("/stats") ||
      requestPath.includes("/settings") ||
      requestPath.includes("/status") ||
      requestPath.includes("/profile") ||
      requestPath.includes("/memory") ||
      requestPath.includes("/theme")
    ) {
      return {}
    }
  }

  if (method === "DELETE" || method === "PATCH" || method === "POST") {
    return true
  }

  return null
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return String(value || "")
  }
}

async function getDirectorySizeBytes(targetDir) {
  try {
    const stat = await fs.promises.stat(targetDir)
    if (!stat.isDirectory()) return 0
  } catch {
    return 0
  }

  let total = 0
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      total += await getDirectorySizeBytes(fullPath)
      continue
    }
    if (entry.isFile()) {
      try {
        const s = await fs.promises.stat(fullPath)
        total += s.size
      } catch {
      }
    }
  }
  return total
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let unitIndex = 0
  let current = value
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024
    unitIndex += 1
  }
  const rounded = current >= 10 || unitIndex === 0 ? Math.round(current) : Math.round(current * 10) / 10
  return `${rounded} ${units[unitIndex]}`
}

function buildPlaceholderAnimeMedia(mediaId) {
  const id = Number(mediaId || 0)
  return {
    id,
    idMal: 0,
    siteUrl: "",
    status: "UNKNOWN",
    season: null,
    type: "ANIME",
    format: null,
    seasonYear: null,
    bannerImage: "",
    episodes: 0,
    synonyms: [],
    isAdult: false,
    countryOfOrigin: "",
    meanScore: 0,
    description: "",
    genres: [],
    duration: 0,
    trailer: null,
    title: {
      english: "",
      native: "",
      romaji: "",
      userPreferred: `Media ${id}`
    },
    coverImage: {
      color: "",
      extraLarge: "",
      large: "",
      medium: ""
    },
    startDate: { day: 0, month: 0, year: 0 },
    endDate: { day: 0, month: 0, year: 0 },
    nextAiringEpisode: null,
    streamingEpisodes: []
  }
}

function buildPlaceholderMangaMedia(mediaId) {
  const id = Number(mediaId || 0)
  return {
    id,
    idMal: 0,
    siteUrl: "",
    status: "UNKNOWN",
    type: "MANGA",
    format: null,
    chapters: 0,
    volumes: 0,
    synonyms: [],
    isAdult: false,
    countryOfOrigin: "",
    meanScore: 0,
    description: "",
    genres: [],
    title: {
      english: "",
      native: "",
      romaji: "",
      userPreferred: `Media ${id}`
    },
    coverImage: {
      color: "",
      extraLarge: "",
      large: "",
      medium: ""
    },
    startDate: { day: 0, month: 0, year: 0 },
    endDate: { day: 0, month: 0, year: 0 },
  }
}

function pickBestMangaSearchResult(query, results) {
  if (!Array.isArray(results) || !results.length) return null
  const normalizedQuery = normalizeText(query)
  let best = results[0]
  let bestScore = -1

  for (const item of results) {
    const title = String(item?.title || "")
    const synonyms = Array.isArray(item?.synonyms) ? item.synonyms : []
    const rating = typeof item?.searchRating === "number" ? item.searchRating : 0

    const candidateTexts = [title, ...synonyms].map(normalizeText).filter(Boolean)
    let textScore = 0
    for (const candidate of candidateTexts) {
      if (candidate === normalizedQuery) {
        textScore = Math.max(textScore, 5)
      } else if (candidate.includes(normalizedQuery) || normalizedQuery.includes(candidate)) {
        textScore = Math.max(textScore, 3)
      }
    }

    const score = (rating * 10) + textScore
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }

  return best
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function filterAnimeOnlyRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.filter((row) => {
    try {
      const media = typeof row?.media_json === "string" ? JSON.parse(row.media_json) : row?.media_json
      const type = String(media?.type || "").trim().toUpperCase()
      return !type || type === "ANIME"
    } catch {
      return true
    }
  })
}

function getQbClient(dbRef) {
  const settings = getSettings(dbRef)
  const qbConfig = getQbittorrentConfigFromSettings(settings)
  if (!qbConfig) return null

  const key = `${qbConfig.host}:${qbConfig.port}:${qbConfig.username}:${qbConfig.password}`
  if (qbClientCache.key === key && qbClientCache.client) {
    return qbClientCache.client
  }

  qbClientCache = { key, client: new QbittorrentClient(qbConfig) }
  return qbClientCache.client
}

function waitMs(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function wrapRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error) {
      next(error)
    }
  }
}

function emptyAnimeCollection() {
  return {
    MediaListCollection: {
      lists: []
    }
  }
}

function emptyLibraryCollection() {
  return {
    continueWatchingList: [],
    lists: [],
    unmatchedLocalFiles: [],
    unmatchedGroups: [],
    ignoredLocalFiles: [],
    unknownGroups: [],
    stats: {
      totalEntries: 0,
      totalFiles: 0,
      totalShows: 0,
      totalMovies: 0,
      totalSpecials: 0,
      totalSize: "0 B"
    },
    stream: {
      continueWatchingList: [],
      anime: [],
      listData: {}
    }
  }
}

function emptyMangaAnilistCollection() {
  return {
    MediaListCollection: {
      lists: []
    }
  }
}

function emptyMangaCollection() {
  return {
    lists: []
  }
}

function emptyAllExtensions() {
  return {
    extensions: [],
    invalidExtensions: [],
    invalidUserConfigExtensions: [],
    hasUpdate: [],
    unsafeExtensions: {}
  }
}

function emptyListedAnime() {
  return {
    Page: {
      media: [],
      pageInfo: {
        currentPage: 1,
        hasNextPage: false,
        lastPage: 1,
        perPage: 0,
        total: 0
      }
    }
  }
}

function buildMissingEpisodes(rows) {
  const episodes = []
  for (const row of rows) {
    const media = JSON.parse(row.media_json)
    const totalEpisodes = Number(media?.episodes || 0)
    const progress = Number(row.progress || 0)
    if (!totalEpisodes || progress >= totalEpisodes) continue
    for (let episodeNumber = progress + 1; episodeNumber <= totalEpisodes; episodeNumber += 1) {
      episodes.push({
        type: "main",
        displayTitle: `Episode ${episodeNumber}`,
        episodeTitle: "",
        episodeNumber,
        absoluteEpisodeNumber: episodeNumber,
        progressNumber: episodeNumber,
        isDownloaded: false,
        isInvalid: false,
        baseAnime: media,
        _isNakamaEpisode: false
      })
    }
  }

  return {
    episodes,
    silencedEpisodes: []
  }
}

function inferStatus(progress, totalEpisodes, fallback = "PLANNING") {
  if (totalEpisodes > 0 && progress >= totalEpisodes) {
    return "COMPLETED"
  }
  if (progress > 0) {
    return "CURRENT"
  }
  return fallback || "PLANNING"
}

function fuzzyDateToIso(value) {
  if (!value?.year || !value?.month) return null
  const day = value.day || 1
  const month = String(value.month).padStart(2, "0")
  const safeDay = String(day).padStart(2, "0")
  return `${value.year}-${month}-${safeDay}T00:00:00.000Z`
}

function autoStartedAt(progress) {
  return progress > 0 ? new Date().toISOString() : null
}

function autoCompletedAt(status) {
  return status === "COMPLETED" ? new Date().toISOString() : null
}

async function handleVideoProxy(req, res, headOnly) {
  const targetUrl = String(req.query?.url || "").trim()
  if (!targetUrl) {
    throw new Error("url is required")
  }

  let headerMap = {}
  const rawHeaders = String(req.query?.headers || "").trim()
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        headerMap = parsed
      }
    } catch {
      throw new Error("headers must be valid JSON")
    }
  }

  const upstreamHeaders = buildProxyRequestHeaders(headerMap, req)

  if (headOnly && isHlsUrl(targetUrl)) {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
    res.status(200).end()
    return
  }

  let response = await fetchProxyTarget(targetUrl, upstreamHeaders)
  if (!response.ok) {
    logWarn("proxy", `fetch upstream returned ${response.status} for ${targetUrl}`)
  }
  if (!response.ok && isHlsUrl(targetUrl)) {
    const retryHeaders = buildProxyRequestHeaders(headerMap, req, { hlsRetry: true })
    response = await fetchProxyTarget(targetUrl, retryHeaders)
    if (!response.ok) {
      logWarn("proxy", `fetch retry returned ${response.status} for ${targetUrl}`)
    }
  }

  if (!response.ok && isHlsUrl(targetUrl)) {
    const curlResult = await fetchProxyTargetWithCurl(targetUrl, upstreamHeaders)
    if (curlResult) {
      logWarn("proxy", `curl fallback returned ${curlResult.status} for ${targetUrl}`)
      const contentType = curlResult.headers.get("content-type") || "application/vnd.apple.mpegurl"
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
      res.setHeader("Content-Type", contentType)
      res.setHeader("Cache-Control", curlResult.headers.get("cache-control") || "no-cache")

      const playlistBody = Buffer.from(curlResult.body).toString("utf8")
      if (headOnly) {
        res.status(200).end()
        return
      }

      if (playlistBody.trimStart().startsWith("#EXTM3U")) {
        res.status(200).end(rewriteHlsPlaylist(playlistBody, targetUrl, headerMap))
        return
      }
    }
  }

  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (
      lowerKey === "content-length" ||
      lowerKey === "content-encoding" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "connection"
    ) {
      continue
    }
    res.setHeader(key, value)
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
  res.status(response.status)

  if (headOnly) {
    res.end()
    if (response.body) {
      try {
        await response.body.cancel()
      } catch {
      }
    }
    return
  }

  const isHlsPlaylist = isHlsUrl(targetUrl) || isHlsContentType(response.headers.get("content-type"))
  if (!isHlsPlaylist) {
    if (!response.body) {
      res.end()
      return
    }

    if (shouldBufferProxyBody(targetUrl, response)) {
      const bodyBuffer = Buffer.from(await response.arrayBuffer())
      if (!res.getHeader("Content-Type")) {
        res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream")
      }
      res.setHeader("Content-Length", String(bodyBuffer.length))
      res.end(bodyBuffer)
      return
    }

    const upstreamStream = Readable.fromWeb(response.body)
    upstreamStream.on("error", error => {
      logWarn("proxy", `upstream stream error for ${targetUrl}`, error)
      if (!res.headersSent) {
        res.status(502).end()
        return
      }
      res.destroy(error)
    })
    upstreamStream.pipe(res)
    return
  }

  const originalPlaylist = await response.text()
  const rewrittenPlaylist = rewriteHlsPlaylist(originalPlaylist, targetUrl, headerMap)

  res.setHeader("Content-Type", "application/vnd.apple.mpegurl")
  res.setHeader("Cache-Control", response.headers.get("cache-control") || "no-cache")
  if (originalPlaylist.trimStart().startsWith("#EXTM3U")) {
    res.status(200)
  }
  res.end(rewrittenPlaylist)
}

function buildProxyRequestHeaders(headerMap, req, { hlsRetry = false } = {}) {
  const upstreamHeaders = new Headers()
  upstreamHeaders.set("Accept", hlsRetry
    ? "application/vnd.apple.mpegurl, application/x-mpegURL, application/octet-stream, */*"
    : "*/*")
  upstreamHeaders.set("Accept-Encoding", "identity")
  upstreamHeaders.set("Accept-Language", "en-US,en;q=0.9")
  upstreamHeaders.set("Cache-Control", "no-cache")
  upstreamHeaders.set("Pragma", "no-cache")
  upstreamHeaders.set("Sec-Fetch-Dest", "empty")
  upstreamHeaders.set("Sec-Fetch-Mode", "cors")
  upstreamHeaders.set("Sec-Fetch-Site", "cross-site")

  for (const [key, value] of Object.entries(headerMap)) {
    if (value !== undefined && value !== null) {
      upstreamHeaders.set(key, String(value))
    }
  }

  if (!upstreamHeaders.has("User-Agent")) {
    upstreamHeaders.set(
      "User-Agent",
      req.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    )
  }

  const rangeHeader = req.get("Range")
  if (rangeHeader) {
    upstreamHeaders.set("Range", rangeHeader)
  }

  return upstreamHeaders
}

function shouldBufferProxyBody(targetUrl, response) {
  const contentLength = Number(response.headers.get("content-length") || 0)
  if (contentLength > 0 && contentLength <= 16 * 1024 * 1024) {
    return true
  }

  return /\.(ts|m4s|cmfv|cmfa|aac|m4a|mp3|key|jpg|jpeg|png|webp)(?:$|\?)/i.test(targetUrl) ||
    /\/seg-[^/]+$/i.test(targetUrl)
}

async function fetchTextContent(url) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    }
  })

  if (!response.ok) {
    throw new Error(`failed to fetch subtitle content (${response.status})`)
  }

  return response.text()
}

async function fetchProxyTarget(targetUrl, headers) {
  return fetch(targetUrl, {
    method: "GET",
    headers,
    redirect: "follow"
  })
}

async function fetchProxyTargetWithCurl(targetUrl, headers) {
  try {
    const args = [
      "-L",
      "--silent",
      "--show-error",
      "--include",
      "--insecure",
      "--http2",
      "--path-as-is",
      "--retry",
      "1",
      "--connect-timeout",
      "10",
      "--max-time",
      "25"
    ]

    if (headers.get("User-Agent")) {
      args.push("--user-agent", headers.get("User-Agent"))
    }

    if (headers.get("Referer")) {
      args.push("--referer", headers.get("Referer"))
    }

    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase() === "user-agent" || key.toLowerCase() === "referer") {
        continue
      }
      args.push("-H", `${key}: ${value}`)
    }
    args.push(targetUrl)

    const { stdout } = await execFileAsync("curl", args, {
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024
    })

    const marker = Buffer.from("\r\n\r\n")
    let offset = 0
    let headerText = ""
    let body = stdout

    while (offset < stdout.length) {
      const splitIndex = stdout.indexOf(marker, offset)
      if (splitIndex === -1) {
        break
      }

      headerText = stdout.subarray(offset, splitIndex).toString("utf8")
      body = stdout.subarray(splitIndex + marker.length)
      if (!/^HTTP\/\d\.\d 3\d\d/m.test(headerText)) {
        break
      }
      offset = splitIndex + marker.length
    }

    if (!headerText) {
      return null
    }

    const lines = headerText.split(/\r?\n/)
    const statusLine = lines.shift() || ""
    const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/)
    const status = Number(statusMatch?.[1] || 0)
    const parsedHeaders = new Headers()

    for (const line of lines) {
      const index = line.indexOf(":")
      if (index === -1) continue
      parsedHeaders.append(line.slice(0, index).trim(), line.slice(index + 1).trim())
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: parsedHeaders,
      body
    }
  } catch {
    return null
  }
}

function isHlsUrl(url) {
  return String(url || "").toLowerCase().includes(".m3u8")
}

function isHlsContentType(contentType) {
  const value = String(contentType || "").toLowerCase()
  return value.includes("mpegurl")
}

function rewriteHlsPlaylist(content, targetUrl, headerMap) {
  const baseUrl = new URL(targetUrl)
  const lines = String(content || "").split(/\r?\n/)
  const output = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || line.startsWith("#")) {
      output.push(rewriteHlsDirective(line, baseUrl, headerMap))
      continue
    }

    output.push(toProxyUrl(resolveRelativeUrl(baseUrl, line), headerMap))
  }

  return output.join("\n")
}

function convertSubtitleContent(content, to) {
  const normalizedTarget = to === "vtt" ? "vtt" : "ass"
  const normalizedSource = detectSubtitleFormat(content)

  if (normalizedTarget === "vtt") {
    if (normalizedSource === "vtt") {
      return normalizeVtt(content)
    }
    if (normalizedSource === "srt") {
      return srtToVtt(content)
    }
    if (normalizedSource === "ass") {
      return assToVtt(content)
    }
    return normalizeVtt(content)
  }

  if (normalizedSource === "ass") {
    return content
  }
  if (normalizedSource === "srt") {
    return cuesToAss(parseSrtCues(content))
  }
  if (normalizedSource === "vtt") {
    return cuesToAss(parseVttCues(content))
  }
  return cuesToAss(parseLooseTextCues(content))
}

function detectSubtitleFormat(content) {
  const trimmed = String(content || "").trimStart()
  if (trimmed.startsWith("WEBVTT")) return "vtt"
  if (/^\[Script Info\]/m.test(trimmed) || /^\[V4\+ Styles\]/m.test(trimmed)) return "ass"
  if (/\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(trimmed)) return "srt"
  if (/\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(trimmed)) return "vtt"
  return "text"
}

function normalizeVtt(content) {
  const body = String(content || "").replace(/^\uFEFF/, "").trim()
  if (body.startsWith("WEBVTT")) {
    return `${body}\n`
  }
  return `WEBVTT\n\n${body}\n`
}

function srtToVtt(content) {
  const body = String(content || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim()
  return `WEBVTT\n\n${body}\n`
}

function assToVtt(content) {
  const cues = []
  const lines = String(content || "").replace(/\r/g, "").split("\n")

  for (const line of lines) {
    if (!line.startsWith("Dialogue:")) continue
    const payload = line.slice("Dialogue:".length).trim()
    const parts = payload.split(",")
    if (parts.length < 10) continue
    const start = assTimeToVtt(parts[1])
    const end = assTimeToVtt(parts[2])
    const text = parts.slice(9).join(",")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/g, "\n")
      .trim()
    if (!text) continue
    cues.push(`${start} --> ${end}\n${text}`)
  }

  return `WEBVTT\n\n${cues.join("\n\n")}\n`
}

function parseSrtCues(content) {
  const blocks = String(content || "").replace(/^\uFEFF/, "").replace(/\r/g, "").trim().split(/\n\s*\n/)
  const cues = []

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean)
    if (!lines.length) continue
    const timeLineIndex = lines.findIndex(line => line.includes("-->"))
    if (timeLineIndex === -1) continue
    const timeLine = lines[timeLineIndex]
    const match = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})/)
    if (!match) continue
    const text = lines.slice(timeLineIndex + 1).join("\\N").trim()
    if (!text) continue
    cues.push({
      start: srtTimeToAss(match[1]),
      end: srtTimeToAss(match[2]),
      text: escapeAssText(text)
    })
  }

  return cues
}

function parseVttCues(content) {
  const blocks = String(content || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*\n*/i, "")
    .trim()
    .split(/\n\s*\n/)
  const cues = []

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean)
    if (!lines.length) continue
    const timeLineIndex = lines.findIndex(line => line.includes("-->"))
    if (timeLineIndex === -1) continue
    const timeLine = lines[timeLineIndex]
    const match = timeLine.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/)
    if (!match) continue
    const text = lines.slice(timeLineIndex + 1).join("\\N").trim()
    if (!text) continue
    cues.push({
      start: vttTimeToAss(match[1]),
      end: vttTimeToAss(match[2]),
      text: escapeAssText(text)
    })
  }

  return cues
}

function parseLooseTextCues(content) {
  const text = String(content || "").trim()
  if (!text) return []
  return [{
    start: "0:00:00.00",
    end: "9:59:59.99",
    text: escapeAssText(text)
  }]
}

function cuesToAss(cues) {
  const header = `[Script Info]
Title: Converted subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Roboto Medium,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1.3,0,2,20,20,23,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const body = cues.map(cue => `Dialogue: 0,${cue.start},${cue.end},Default,,0,0,0,,${cue.text}`).join("\n")
  return `${header}\n${body}\n`
}

function srtTimeToAss(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!match) return "0:00:00.00"
  const [, hours, minutes, seconds, milliseconds] = match
  return `${Number(hours)}:${minutes}:${seconds}.${milliseconds.slice(0, 2)}`
}

function vttTimeToAss(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
  if (!match) return "0:00:00.00"
  const [, hours, minutes, seconds, milliseconds] = match
  return `${Number(hours)}:${minutes}:${seconds}.${milliseconds.slice(0, 2)}`
}

function assTimeToVtt(value) {
  const match = String(value || "").match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/)
  if (!match) return "00:00:00.000"
  const [, hours, minutes, seconds, centiseconds] = match
  return `${String(Number(hours)).padStart(2, "0")}:${minutes}:${seconds}.${centiseconds}0`
}

function escapeAssText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\N")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
}

function rewriteHlsDirective(line, baseUrl, headerMap) {
  if (!line.includes("URI=\"")) {
    return line
  }

  return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
    const resolved = resolveRelativeUrl(baseUrl, uri)
    return `URI="${toProxyUrl(resolved, headerMap)}"`
  })
}

function resolveRelativeUrl(baseUrl, value) {
  const input = String(value || "").trim()
  if (!input || input.startsWith("/api/v1/proxy?url=")) {
    return input
  }

  try {
    return new URL(input, baseUrl).toString()
  } catch {
    return input
  }
}

function toProxyUrl(targetUrl, headerMap) {
  const url = String(targetUrl || "").trim()
  if (!url || url.includes("/api/v1/proxy?url=")) {
    return url
  }

  let proxyUrl = `/api/v1/proxy?url=${encodeURIComponent(url)}`
  if (headerMap && Object.keys(headerMap).length > 0) {
    proxyUrl += `&headers=${encodeURIComponent(JSON.stringify(headerMap))}`
  }
  return proxyUrl
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "number") {
    return value !== 0
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (!normalized || normalized === "false" || normalized === "0" || normalized === "off" || normalized === "no") {
      return false
    }
    if (normalized === "true" || normalized === "1" || normalized === "on" || normalized === "yes") {
      return true
    }
  }

  return Boolean(value)
}

function getContinuityUserKey(req) {
  const account = getAccount(db)
  const accountToken = String(req?.cookies?.["nixer_user_token"] || "").trim()
  if (account && accountToken && accountToken === account.token) {
    return "account:local"
  }

  const clientId = String(req?.clientId || req?.cookies?.["Nixer-Client-Id"] || req?.cookies?.["Seanime-Client-Id"] || "").trim()
  return clientId ? `client:${clientId}` : "global"
}

function buildEpisodeCollection(media, options = {}) {
  const totalEpisodes = Number(
    media?.episodes ||
    Math.max(Number(media?.nextAiringEpisode?.episode || 1) - 1, 0)
  )
  const continuity = normalizeEpisodeContinuity(options.continuity || null)

  return {
    hasMappingError: false,
    metadata: null,
    episodes: Array.from({ length: totalEpisodes }, (_value, index) => {
      const episodeNumber = index + 1
      const isActiveContinuityEpisode = episodeNumber === Number(continuity?.episodeNumber || 0)
      const currentTime = isActiveContinuityEpisode ? continuity.currentTime : 0
      const duration = isActiveContinuityEpisode ? continuity.duration : 0
      const progress = isActiveContinuityEpisode ? continuity.progress : 0
      return {
        type: "main",
        displayTitle: media?.format === "MOVIE" ? media?.title?.userPreferred || "Movie" : `Episode ${episodeNumber}`,
        episodeTitle: "",
        episodeNumber,
        aniDBEpisode: String(episodeNumber),
        absoluteEpisodeNumber: episodeNumber,
        progressNumber: episodeNumber,
        currentTime,
        duration,
        progress,
        playbackProgress: {
          currentTime,
          duration,
          progress,
        },
        hasProgress: progress > 0,
        isDownloaded: false,
        isInvalid: true,
        baseAnime: media,
        _isNakamaEpisode: false
      }
    })
  }
}

function normalizeEpisodeContinuity(item) {
  if (!item || typeof item !== "object") {
    return null
  }

  const episodeNumber = Number(item.episodeNumber || 0)
  const currentTime = Number(item.currentTime || 0)
  const duration = Number(item.duration || 0)
  if (!episodeNumber || !(currentTime > 0) || !(duration > 0)) {
    return null
  }

  return {
    episodeNumber,
    currentTime,
    duration,
    progress: Math.max(0, Math.min(100, (currentTime / duration) * 100)),
  }
}

async function deleteEmptyDirectories(rootDir) {
  const resolvedRoot = path.resolve(rootDir)

  async function walk(dir) {
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return 0
    }

    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const childDir = path.join(dir, entry.name)
      removed += await walk(childDir)
    }

    if (dir === resolvedRoot) return removed

    try {
      const remaining = await fs.promises.readdir(dir)
      if (remaining.length === 0) {
        await fs.promises.rmdir(dir)
        removed += 1
      }
    } catch {
    }

    return removed
  }

  return walk(resolvedRoot)
}

async function tryOpenInExplorer(execFileAsync, targetPath) {
  const resolved = path.resolve(targetPath)
  try {
    const stat = await fs.promises.stat(resolved)
    const dir = stat.isDirectory() ? resolved : path.dirname(resolved)

    if (process.platform === "win32") {
      await execFileAsync("explorer.exe", [dir])
      return true
    }
    if (process.platform === "darwin") {
      await execFileAsync("open", [dir])
      return true
    }
    await execFileAsync("xdg-open", [dir])
    return true
  } catch {
    return false
  }
}

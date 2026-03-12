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

import { getAnimeDetails, listAnime, listRecentAnime } from "./anilist-client.mjs"
import { getConfig } from "./config.mjs"
import {
  createDb,
  getContinuityWatchHistory,
  getContinuityWatchHistoryItem,
  deleteLocalAnimeEntry,
  getAccount,
  getLocalAnimeEntries,
  getLocalAnimeEntry,
  getSettings,
  getTheme,
  saveAccount,
  saveSettings,
  saveTheme,
  upsertContinuityWatchHistoryItem,
  upsertLocalAnimeEntry
} from "./db.mjs"
import { buildAnimeCollection, buildAnimeEntry, buildLibraryCollection, buildLocalStats, buildRemoteAnimeEntry } from "./local-anime.mjs"
import { defaultHomeItems } from "./defaults.mjs"
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
import { logError, logInfo, logWarn } from "./logging.mjs"
import { dataResponse } from "./response.mjs"
import { getStatus } from "./state.mjs"
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

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, app: "NixerNodeFull" })
})

app.get("/api/v1/status", wrapRoute((req, res) => {
  res.json(dataResponse(getStatus({ db, config, req })))
}))

app.get("/api/v1/settings", wrapRoute((_req, res) => {
  res.json(dataResponse(getSettings(db)))
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

app.get("/api/v1/torrent-client/list", (_req, res) => {
  res.json(dataResponse([]))
})

app.get("/api/v1/anilist/collection", (_req, res) => {
  res.json(dataResponse(buildAnimeCollection(getLocalAnimeEntries(db))))
})

app.post("/api/v1/anilist/collection", (_req, res) => {
  res.json(dataResponse(buildAnimeCollection(getLocalAnimeEntries(db))))
})

app.get("/api/v1/anilist/collection/raw", (_req, res) => {
  res.json(dataResponse(buildAnimeCollection(getLocalAnimeEntries(db))))
})

app.post("/api/v1/anilist/collection/raw", (_req, res) => {
  res.json(dataResponse(buildAnimeCollection(getLocalAnimeEntries(db))))
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
  res.json(dataResponse(emptyMangaAnilistCollection()))
})

app.get("/api/v1/manga/anilist/collection/raw", (_req, res) => {
  res.json(dataResponse(emptyMangaAnilistCollection()))
})

app.post("/api/v1/manga/anilist/collection/raw", (_req, res) => {
  res.json(dataResponse(emptyMangaAnilistCollection()))
})

app.get("/api/v1/manga/collection", (_req, res) => {
  res.json(dataResponse(emptyMangaCollection()))
})

app.get("/api/v1/manga/latest-chapter-numbers", (_req, res) => {
  res.json(dataResponse({}))
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
  const media = await getAnimeDetails(req.params.id)
  res.json(dataResponse(media))
}))

app.post("/api/v1/anilist/list-entry", wrapRoute(async (req, res) => {
  const body = req.body || {}
  const mediaId = Number(body.mediaId)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  const existing = getLocalAnimeEntry(db, mediaId)
  const media = existing ? JSON.parse(existing.media_json) : await getAnimeDetails(mediaId)
  if (!media) {
    throw new Error("anime not found")
  }

  const hasProgress = Object.prototype.hasOwnProperty.call(body, "progress")
  const hasStatus = Object.prototype.hasOwnProperty.call(body, "status")
  const hasScore = Object.prototype.hasOwnProperty.call(body, "score")
  const hasRepeat = Object.prototype.hasOwnProperty.call(body, "repeat")
  const hasStartedAt = Object.prototype.hasOwnProperty.call(body, "startedAt")
  const hasCompletedAt = Object.prototype.hasOwnProperty.call(body, "completedAt")

  const progress = hasProgress
    ? Number(body.progress ?? 0)
    : Number(existing?.progress ?? 0)
  const totalEpisodes = Number(media?.episodes || 0)
  const status = hasStatus
    ? String(body.status || inferStatus(progress, totalEpisodes, existing?.status))
    : String(existing?.status || inferStatus(progress, totalEpisodes, existing?.status))
  const score = hasScore ? Number(body.score ?? 0) : Number(existing?.score ?? 0)
  const repeatCount = hasRepeat ? Number(body.repeat ?? 0) : Number(existing?.repeat_count ?? 0)
  const startedAt = hasStartedAt
    ? (fuzzyDateToIso(body.startedAt) || null)
    : (existing?.started_at || autoStartedAt(progress))
  const completedAt = hasCompletedAt
    ? (fuzzyDateToIso(body.completedAt) || null)
    : (
      status === "COMPLETED"
        ? (existing?.completed_at || autoCompletedAt(status))
        : (hasStatus ? null : (existing?.completed_at || null))
    )

  upsertLocalAnimeEntry(db, {
    media_id: mediaId,
    media_json: JSON.stringify(media),
    status,
    progress,
    score,
    repeat_count: repeatCount,
    started_at: startedAt,
    completed_at: completedAt,
    created_at: existing?.created_at
  })

  notifySyncStateChanged("anime-list", { mediaId })
  res.json(dataResponse(true))
}))

app.delete("/api/v1/anilist/list-entry", wrapRoute((req, res) => {
  const body = req.body || {}
  const mediaId = Number(body.mediaId)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  deleteLocalAnimeEntry(db, mediaId)
  notifySyncStateChanged("anime-list", { mediaId })
  res.json(dataResponse(true))
}))

app.post("/api/v1/library/unknown-media", wrapRoute(async (req, res) => {
  const mediaIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds.map(Number).filter(Boolean) : []
  for (const mediaId of mediaIds) {
    const existing = getLocalAnimeEntry(db, mediaId)
    if (existing) continue
    const media = await getAnimeDetails(mediaId)
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

  const media = await getAnimeDetails(req.params.id)
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
  const body = req.body || {}
  const mediaId = Number(body.mediaId)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  const row = getLocalAnimeEntry(db, mediaId)
  const media = row ? JSON.parse(row.media_json) : await getAnimeDetails(mediaId)
  if (!media) {
    throw new Error("anime not found")
  }

  const progress = Number(body.episodeNumber || 0)
  const totalEpisodes = Number(body.totalEpisodes || media?.episodes || 0)
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
  const body = req.body || {}
  const mediaId = Number(body.mediaId)
  const row = getLocalAnimeEntry(db, mediaId)
  if (!row) {
    throw new Error("anime entry not found")
  }

  upsertLocalAnimeEntry(db, {
    ...row,
    media_id: row.media_id,
    media_json: row.media_json,
    repeat_count: Number(body.repeat || 0)
  })

  notifySyncStateChanged("anime-list", { mediaId })
  res.json(dataResponse(true))
}))

app.post("/api/v1/onlinestream/episode-list", wrapRoute(async (req, res) => {
  const mediaId = Number(req.body?.mediaId)
  const provider = String(req.body?.provider || "").trim()
  const dubbed = parseBoolean(req.body?.dubbed)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }

  res.json(dataResponse(await getOnlineStreamEpisodeList(config, mediaId, provider, dubbed)))
}))

app.post("/api/v1/onlinestream/episode-source", wrapRoute(async (req, res) => {
  const mediaId = Number(req.body?.mediaId)
  const provider = String(req.body?.provider || "").trim()
  const dubbed = parseBoolean(req.body?.dubbed)
  const episodeNumber = Number(req.body?.episodeNumber)
  if (!mediaId) {
    throw new Error("mediaId is required")
  }
  if (!provider) {
    throw new Error("provider is required")
  }
  if (!episodeNumber) {
    throw new Error("episodeNumber is required")
  }

  res.json(dataResponse(await getOnlineStreamEpisodeSource(config, mediaId, provider, episodeNumber, dubbed)))
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

app.use("/api/v1", (req, res) => {
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
    collection: buildAnimeCollection(getLocalAnimeEntries(db)),
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

import bcrypt from "bcryptjs"

import {
  createDb,
  getContinuityWatchHistory,
  getLocalAnimeEntries,
  getSettings,
  getTheme,
  saveAccount,
  saveSettings,
  saveTheme,
  upsertContinuityWatchHistoryItem,
  upsertLocalAnimeEntry,
} from "./db.mjs"
import { buildAnimeCollection } from "./local-anime.mjs"
import { getStatus } from "./state.mjs"
import {
  DEFAULT_REMOTE_SERVER_URL,
  DESKTOP_SYNC_LOCAL_TOKEN,
} from "./desktop-sync-constants.mjs"

const REMOTE_ONLY_PASSWORD = "desktop-sync-remote-only"

export async function synchronizeRemoteState({
  config,
  remoteUrl = DEFAULT_REMOTE_SERVER_URL,
  email,
  password,
}) {
  if (!config) {
    throw new Error("config is required")
  }

  const normalizedEmail = String(email || "").trim().toLowerCase()
  const normalizedPassword = String(password || "")
  if (!normalizedEmail) {
    throw new Error("email is required")
  }
  if (!normalizedPassword) {
    throw new Error("password is required")
  }

  const remote = new RemoteApiSession(remoteUrl)
  await remote.login(normalizedEmail, normalizedPassword)

  const exportedState = await remote.fetchData("/api/v1/desktop-sync/export")
  const statusResponse = exportedState?.status || null
  const settingsResponse = exportedState?.settings || {}
  const themeResponse = exportedState?.theme || {}
  const collectionResponse = exportedState?.collection || null
  const continuityResponse = exportedState?.continuity || null

  const rows = extractAnimeRows(collectionResponse)
  const continuityItems = extractContinuityItems(continuityResponse)
  const remoteUser = statusResponse?.user && !statusResponse.user.isSimulated ? statusResponse.user : null
  const passwordHash = remoteUser ? await bcrypt.hash(REMOTE_ONLY_PASSWORD, 10) : null

  const db = createDb(config)

  try {
    const applySync = db.transaction(() => {
      saveSettings(db, settingsResponse || {})
      saveTheme(db, themeResponse || {})

      db.prepare("DELETE FROM local_anime_entries").run()
      db.prepare("DELETE FROM continuity_watch_history").run()

      for (const row of rows) {
        upsertLocalAnimeEntry(db, row)
      }

      for (const item of continuityItems) {
        upsertContinuityWatchHistoryItem(db, item)
      }

      if (remoteUser && passwordHash) {
        const account = buildSyncedAccount({
          email: normalizedEmail,
          passwordHash,
          remoteUser,
        })
        saveAccount(db, account)
      }
    })

    applySync()
  } finally {
    db.close()
  }

  return {
    remoteUrl: remote.origin,
    syncedAt: new Date().toISOString(),
    entriesSynced: rows.length,
    continuityItemsSynced: continuityItems.length,
    settingsSynced: Boolean(settingsResponse),
    themeSynced: Boolean(themeResponse),
    userSynced: Boolean(remoteUser),
    localToken: remoteUser ? DESKTOP_SYNC_LOCAL_TOKEN : "",
  }
}

export function exportLocalDesktopSyncState({ config, req = { cookies: {}, headers: {} } }) {
  if (!config) {
    throw new Error("config is required")
  }

  const db = createDb(config)
  try {
    return {
      exportedAt: new Date().toISOString(),
      status: getStatus({ db, config, req }),
      settings: getSettings(db),
      theme: getTheme(db),
      collection: buildAnimeCollection(getLocalAnimeEntries(db)),
      continuity: getContinuityWatchHistory(db, "global"),
    }
  } finally {
    db.close()
  }
}

export async function pushLocalStateToRemote({
  config,
  remoteUrl = DEFAULT_REMOTE_SERVER_URL,
  email,
  password,
}) {
  if (!config) {
    throw new Error("config is required")
  }

  const normalizedEmail = String(email || "").trim().toLowerCase()
  const normalizedPassword = String(password || "")
  if (!normalizedEmail) {
    throw new Error("email is required")
  }
  if (!normalizedPassword) {
    throw new Error("password is required")
  }

  const remote = new RemoteApiSession(remoteUrl)
  await remote.login(normalizedEmail, normalizedPassword)

  const payload = exportLocalDesktopSyncState({ config })
  const result = await remote.sendData("/api/v1/desktop-sync/import", payload)

  return {
    remoteUrl: remote.origin,
    pushedAt: new Date().toISOString(),
    entriesSynced: Number(result?.entriesSynced || 0),
    continuityItemsSynced: Number(result?.continuityItemsSynced || 0),
    settingsSynced: Boolean(result?.settingsSynced),
    themeSynced: Boolean(result?.themeSynced),
  }
}

class RemoteApiSession {
  constructor(remoteUrl) {
    this.origin = normalizeOrigin(remoteUrl)
    this.cookieJar = new Map()
  }

  async login(email, password) {
    await this.request("/api/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    })
  }

  async fetchData(route) {
    const response = await this.request(route)
    const payload = await parseJson(response)
    return payload?.data
  }

  async sendData(route, data) {
    const response = await this.request(route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    })
    const payload = await parseJson(response)
    return payload?.data
  }

  async request(route, init = {}) {
    const response = await fetch(new URL(route, this.origin), {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
        Cookie: this.serializeCookies(),
      },
    })

    this.captureCookies(response)

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`remote request failed for ${route}: ${response.status} ${body || response.statusText}`.trim())
    }

    return response
  }

  captureCookies(response) {
    const cookieHeaders = getSetCookieHeaders(response)
    for (const header of cookieHeaders) {
      const firstPair = String(header || "").split(";")[0]
      const separatorIndex = firstPair.indexOf("=")
      if (separatorIndex <= 0) continue

      const name = firstPair.slice(0, separatorIndex).trim()
      const value = firstPair.slice(separatorIndex + 1).trim()
      if (!name) continue
      this.cookieJar.set(name, value)
    }
  }

  serializeCookies() {
    if (!this.cookieJar.size) {
      return ""
    }

    return Array.from(this.cookieJar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ")
  }
}

function normalizeOrigin(value) {
  const source = String(value || "").trim() || DEFAULT_REMOTE_SERVER_URL
  const withProtocol = /^https?:\/\//i.test(source) ? source : `https://${source}`
  const url = new URL(withProtocol)
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString()
}

function getSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie()
  }

  const singleValue = response.headers.get("set-cookie")
  return singleValue ? [singleValue] : []
}

async function parseJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function extractAnimeRows(collectionResponse) {
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

function extractContinuityItems(continuityResponse) {
  const values = continuityResponse && typeof continuityResponse === "object"
    ? Object.values(continuityResponse)
    : []

  return values
    .map((item) => ({
      userKey: "global",
      mediaId: Number(item?.mediaId || 0),
      kind: String(item?.kind || "onlinestream"),
      filepath: String(item?.filepath || ""),
      episodeNumber: Number(item?.episodeNumber || 0),
      currentTime: Number(item?.currentTime || 0),
      duration: Number(item?.duration || 0),
    }))
    .filter((item) => item.mediaId > 0)
}

function fuzzyDateToIso(value) {
  if (!value || typeof value !== "object") {
    return null
  }

  const year = Number(value.year || 0)
  const month = Number(value.month || 1)
  const day = Number(value.day || 1)

  if (!year) {
    return null
  }

  return new Date(Date.UTC(year, Math.max(month - 1, 0), Math.max(day, 1))).toISOString()
}

function buildSyncedAccount({ email, passwordHash, remoteUser }) {
  const viewer = remoteUser?.viewer && typeof remoteUser.viewer === "object"
    ? remoteUser.viewer
    : {}
  const username = String(viewer.name || email.split("@")[0] || "User").trim() || "User"
  const avatarUrl = typeof viewer.avatar === "string"
    ? viewer.avatar
    : String(viewer.avatar?.medium || viewer.avatar?.large || "")

  return {
    username,
    email,
    password_hash: passwordHash,
    avatar_path: avatarUrl,
    token: DESKTOP_SYNC_LOCAL_TOKEN,
    viewer_json: JSON.stringify({
      viewer: {
        ...viewer,
        name: username,
      },
      token: DESKTOP_SYNC_LOCAL_TOKEN,
      isSimulated: false,
    }),
    is_active: 1,
  }
}

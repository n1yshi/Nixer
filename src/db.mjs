import fs from "node:fs"
import path from "node:path"

import Database from "better-sqlite3"

import { defaultSettings, defaultTheme } from "./defaults.mjs"

export function createDb(config) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
  fs.mkdirSync(config.uploadsDir, { recursive: true })
  fs.mkdirSync(config.logsDir, { recursive: true })

  const db = new Database(config.dbPath)
  db.pragma("journal_mode = WAL")

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar_path TEXT DEFAULT '',
      token TEXT NOT NULL,
      viewer_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS theme (
      id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_anime_entries (
      media_id INTEGER PRIMARY KEY,
      media_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PLANNING',
      progress INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      repeat_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_manga_entries (
      media_id INTEGER PRIMARY KEY,
      media_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PLANNING',
      progress INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      repeat_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS continuity_watch_history (
      user_key TEXT NOT NULL,
      media_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      filepath TEXT NOT NULL DEFAULT '',
      episode_number INTEGER NOT NULL DEFAULT 0,
      current_time REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0,
      time_added TEXT NOT NULL,
      time_updated TEXT NOT NULL,
      PRIMARY KEY (user_key, media_id)
    );

    CREATE TABLE IF NOT EXISTS manga_mappings (
      provider TEXT NOT NULL,
      media_id INTEGER NOT NULL,
      manga_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, media_id)
    );
  `)

  migrateContinuityWatchHistoryTable(db)

  ensureSingleton(db, "settings", defaultSettings())
  ensureSingleton(db, "theme", defaultTheme())

  return db
}

function ensureSingleton(db, table, payload) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = 1`).get()
  if (row) return

  db.prepare(
    `INSERT INTO ${table} (id, payload_json, created_at, updated_at) VALUES (1, ?, ?, ?)`
  ).run(JSON.stringify(payload), payload.createdAt, payload.updatedAt)
}

export function getSettings(db) {
  const row = db.prepare("SELECT payload_json FROM settings WHERE id = 1").get()
  return JSON.parse(row.payload_json)
}

export function saveSettings(db, settings) {
  const now = new Date().toISOString()
  const payload = {
    ...settings,
    id: 1,
    updatedAt: now,
    createdAt: settings.createdAt || now,
  }
  db.prepare("UPDATE settings SET payload_json = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(payload), now)
  return payload
}

export function getTheme(db) {
  const row = db.prepare("SELECT payload_json FROM theme WHERE id = 1").get()
  return normalizeThemePayload(JSON.parse(row.payload_json))
}

export function saveTheme(db, theme) {
  const now = new Date().toISOString()
  const normalizedTheme = normalizeThemePayload(theme)
  const payload = {
    ...defaultTheme(),
    ...normalizedTheme,
    id: 1,
    updatedAt: now,
    createdAt: normalizedTheme.createdAt || now,
  }
  db.prepare("UPDATE theme SET payload_json = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(payload), now)
  return payload
}

function normalizeThemePayload(theme) {
  if (!theme || typeof theme !== "object") {
    return defaultTheme()
  }

  const nestedTheme = theme.theme
  const source = nestedTheme && typeof nestedTheme === "object" ? nestedTheme : theme

  return {
    ...source,
    homeItems: Array.isArray(source.homeItems) ? source.homeItems : defaultTheme().homeItems,
  }
}

export function getAccount(db) {
  return db.prepare("SELECT * FROM accounts WHERE id = 1").get() || null
}

export function saveAccount(db, account) {
  const now = new Date().toISOString()
  const payload = {
    ...account,
    id: 1,
    created_at: account.created_at || now,
    updated_at: now,
  }

  db.prepare(`
    INSERT INTO accounts (
      id, username, email, password_hash, avatar_path, token, viewer_json, is_active, created_at, updated_at
    ) VALUES (
      @id, @username, @email, @password_hash, @avatar_path, @token, @viewer_json, @is_active, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      email = excluded.email,
      password_hash = excluded.password_hash,
      avatar_path = excluded.avatar_path,
      token = excluded.token,
      viewer_json = excluded.viewer_json,
      is_active = excluded.is_active,
      updated_at = excluded.updated_at
  `).run(payload)

  return getAccount(db)
}

export function getLocalAnimeEntries(db) {
  return db.prepare(`
    SELECT
      media_id,
      media_json,
      status,
      progress,
      score,
      repeat_count,
      started_at,
      completed_at,
      created_at,
      updated_at
    FROM local_anime_entries
    ORDER BY updated_at DESC
  `).all()
}

export function getLocalAnimeEntry(db, mediaId) {
  return db.prepare(`
    SELECT
      media_id,
      media_json,
      status,
      progress,
      score,
      repeat_count,
      started_at,
      completed_at,
      created_at,
      updated_at
    FROM local_anime_entries
    WHERE media_id = ?
  `).get(mediaId) || null
}

export function upsertLocalAnimeEntry(db, entry) {
  const now = new Date().toISOString()
  const payload = {
    media_id: entry.media_id,
    media_json: entry.media_json,
    status: entry.status || "PLANNING",
    progress: entry.progress || 0,
    score: entry.score || 0,
    repeat_count: entry.repeat_count || 0,
    started_at: entry.started_at || null,
    completed_at: entry.completed_at || null,
    created_at: entry.created_at || now,
    updated_at: now,
  }

  db.prepare(`
    INSERT INTO local_anime_entries (
      media_id, media_json, status, progress, score, repeat_count, started_at, completed_at, created_at, updated_at
    ) VALUES (
      @media_id, @media_json, @status, @progress, @score, @repeat_count, @started_at, @completed_at, @created_at, @updated_at
    )
    ON CONFLICT(media_id) DO UPDATE SET
      media_json = excluded.media_json,
      status = excluded.status,
      progress = excluded.progress,
      score = excluded.score,
      repeat_count = excluded.repeat_count,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `).run(payload)

  return getLocalAnimeEntry(db, payload.media_id)
}

export function deleteLocalAnimeEntry(db, mediaId) {
  return db.prepare("DELETE FROM local_anime_entries WHERE media_id = ?").run(mediaId)
}

export function getLocalMangaEntries(db) {
  return db.prepare(`
    SELECT
      media_id,
      media_json,
      status,
      progress,
      score,
      repeat_count,
      started_at,
      completed_at,
      created_at,
      updated_at
    FROM local_manga_entries
    ORDER BY updated_at DESC
  `).all()
}

export function getLocalMangaEntry(db, mediaId) {
  return db.prepare(`
    SELECT
      media_id,
      media_json,
      status,
      progress,
      score,
      repeat_count,
      started_at,
      completed_at,
      created_at,
      updated_at
    FROM local_manga_entries
    WHERE media_id = ?
  `).get(mediaId) || null
}

export function upsertLocalMangaEntry(db, entry) {
  const now = new Date().toISOString()
  const payload = {
    media_id: entry.media_id,
    media_json: entry.media_json,
    status: entry.status || "PLANNING",
    progress: entry.progress || 0,
    score: entry.score || 0,
    repeat_count: entry.repeat_count || 0,
    started_at: entry.started_at || null,
    completed_at: entry.completed_at || null,
    created_at: entry.created_at || now,
    updated_at: now,
  }

  db.prepare(`
    INSERT INTO local_manga_entries (
      media_id, media_json, status, progress, score, repeat_count, started_at, completed_at, created_at, updated_at
    ) VALUES (
      @media_id, @media_json, @status, @progress, @score, @repeat_count, @started_at, @completed_at, @created_at, @updated_at
    )
    ON CONFLICT(media_id) DO UPDATE SET
      media_json = excluded.media_json,
      status = excluded.status,
      progress = excluded.progress,
      score = excluded.score,
      repeat_count = excluded.repeat_count,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `).run(payload)

  return getLocalMangaEntry(db, payload.media_id)
}

export function deleteLocalMangaEntry(db, mediaId) {
  return db.prepare("DELETE FROM local_manga_entries WHERE media_id = ?").run(mediaId)
}

export function getContinuityWatchHistory(db, userKey = "global") {
  const rows = db.prepare(`
    SELECT
      user_key,
      media_id,
      kind,
      filepath,
      episode_number,
      "current_time" AS current_time,
      duration,
      time_added,
      time_updated
    FROM continuity_watch_history
    WHERE user_key = @userKey
    UNION ALL
    SELECT
      user_key,
      media_id,
      kind,
      filepath,
      episode_number,
      "current_time" AS current_time,
      duration,
      time_added,
      time_updated
    FROM continuity_watch_history
    WHERE user_key = 'global'
      AND media_id NOT IN (
        SELECT media_id
        FROM continuity_watch_history
        WHERE user_key = @userKey
      )
    ORDER BY time_updated DESC
  `).all({ userKey })

  return Object.fromEntries(rows.map((row) => [
    Number(row.media_id),
    mapContinuityRow(row)
  ]))
}

export function getContinuityWatchHistoryItem(db, userKey = "global", mediaId) {
  const row = db.prepare(`
    SELECT
      user_key,
      media_id,
      kind,
      filepath,
      episode_number,
      "current_time" AS current_time,
      duration,
      time_added,
      time_updated
    FROM continuity_watch_history
    WHERE media_id = @mediaId
      AND user_key IN (@userKey, 'global')
    ORDER BY CASE WHEN user_key = @userKey THEN 0 ELSE 1 END
    LIMIT 1
  `).get({ mediaId, userKey })

  return row ? mapContinuityRow(row) : null
}

export function upsertContinuityWatchHistoryItem(db, item) {
  const now = new Date().toISOString()
  const userKey = String(item.userKey || "global")
  const existing = getContinuityWatchHistoryItem(db, userKey, item.mediaId)
  const payload = {
    user_key: userKey,
    media_id: Number(item.mediaId),
    kind: String(item.kind || "onlinestream"),
    filepath: String(item.filepath || ""),
    episode_number: Number(item.episodeNumber || 0),
    current_time: Number(item.currentTime || 0),
    duration: Number(item.duration || 0),
    time_added: existing?.timeAdded || now,
    time_updated: now,
  }

  if (shouldIgnoreContinuityRegression(existing, payload)) {
    return {
      item: existing,
      ignoredRegression: true,
    }
  }

  db.prepare(`
    INSERT INTO continuity_watch_history (
      user_key, media_id, kind, filepath, episode_number, current_time, duration, time_added, time_updated
    ) VALUES (
      @user_key, @media_id, @kind, @filepath, @episode_number, @current_time, @duration, @time_added, @time_updated
    )
    ON CONFLICT(user_key, media_id) DO UPDATE SET
      kind = excluded.kind,
      filepath = excluded.filepath,
      episode_number = excluded.episode_number,
      current_time = excluded.current_time,
      duration = excluded.duration,
      time_updated = excluded.time_updated
  `).run(payload)

  return {
    item: getContinuityWatchHistoryItem(db, userKey, payload.media_id),
    ignoredRegression: false,
  }
}

export function getMangaMapping(db, provider, mediaId) {
  const row = db.prepare("SELECT manga_id FROM manga_mappings WHERE provider = ? AND media_id = ?")
    .get(String(provider || ""), Number(mediaId || 0))
  return row?.manga_id ? String(row.manga_id) : null
}

export function upsertMangaMapping(db, provider, mediaId, mangaId) {
  const now = new Date().toISOString()
  const safeProvider = String(provider || "")
  const safeMediaId = Number(mediaId || 0)
  const safeMangaId = String(mangaId || "")
  if (!safeProvider) throw new Error("provider is required")
  if (!safeMediaId) throw new Error("mediaId is required")
  if (!safeMangaId) throw new Error("mangaId is required")

  const existing = db.prepare("SELECT provider FROM manga_mappings WHERE provider = ? AND media_id = ?").get(safeProvider, safeMediaId)
  if (existing) {
    db.prepare("UPDATE manga_mappings SET manga_id = ?, updated_at = ? WHERE provider = ? AND media_id = ?")
      .run(safeMangaId, now, safeProvider, safeMediaId)
    return true
  }

  db.prepare("INSERT INTO manga_mappings (provider, media_id, manga_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(safeProvider, safeMediaId, safeMangaId, now, now)
  return true
}

export function deleteMangaMapping(db, provider, mediaId) {
  db.prepare("DELETE FROM manga_mappings WHERE provider = ? AND media_id = ?").run(String(provider || ""), Number(mediaId || 0))
  return true
}

function shouldIgnoreContinuityRegression(existing, nextPayload) {
  if (!existing) return false
  if (Number(existing.episodeNumber || 0) !== Number(nextPayload.episode_number || 0)) return false

  const existingCurrentTime = Number(existing.currentTime || 0)
  const nextCurrentTime = Number(nextPayload.current_time || 0)
  const nextDuration = Number(nextPayload.duration || 0)

  if (!(existingCurrentTime >= 30)) return false
  if (!(nextCurrentTime >= 0 && nextCurrentTime < 10)) return false
  if (nextDuration > 0 && nextCurrentTime >= nextDuration * 0.02) return false

  return true
}

function mapContinuityRow(row) {
  return {
    kind: row.kind,
    filepath: row.filepath || "",
    mediaId: Number(row.media_id),
    episodeNumber: Number(row.episode_number || 0),
    currentTime: Number(row.current_time || 0),
    duration: Number(row.duration || 0),
    timeAdded: row.time_added,
    timeUpdated: row.time_updated,
  }
}

function migrateContinuityWatchHistoryTable(db) {
  const columns = db.prepare("PRAGMA table_info(continuity_watch_history)").all()
  if (!columns.length) {
    return
  }

  const hasUserKey = columns.some((column) => column.name === "user_key")
  const primaryKeyColumns = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name)

  const isCurrentSchema = hasUserKey &&
    primaryKeyColumns.length === 2 &&
    primaryKeyColumns[0] === "user_key" &&
    primaryKeyColumns[1] === "media_id"

  if (isCurrentSchema) {
    return
  }

  db.exec(`
    ALTER TABLE continuity_watch_history RENAME TO continuity_watch_history_legacy;

    CREATE TABLE continuity_watch_history (
      user_key TEXT NOT NULL,
      media_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      filepath TEXT NOT NULL DEFAULT '',
      episode_number INTEGER NOT NULL DEFAULT 0,
      current_time REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0,
      time_added TEXT NOT NULL,
      time_updated TEXT NOT NULL,
      PRIMARY KEY (user_key, media_id)
    );

    INSERT INTO continuity_watch_history (
      user_key,
      media_id,
      kind,
      filepath,
      episode_number,
      current_time,
      duration,
      time_added,
      time_updated
    )
    SELECT
      'global',
      media_id,
      kind,
      filepath,
      episode_number,
      "current_time" AS current_time,
      duration,
      time_added,
      time_updated
    FROM continuity_watch_history_legacy;

    DROP TABLE continuity_watch_history_legacy;
  `)
}

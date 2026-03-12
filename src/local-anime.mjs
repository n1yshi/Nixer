const LIST_STATUSES = ["CURRENT", "PAUSED", "PLANNING", "COMPLETED", "DROPPED", "REPEATING"]

export function buildAnimeCollection(rows) {
  return {
    MediaListCollection: {
      lists: LIST_STATUSES.map((status) => ({
        name: status,
        status,
        isCustomList: false,
        entries: rows
          .filter((row) => normalizeStatus(row.status) === status)
          .map(buildAnimeListEntry)
      })).filter((list) => list.entries.length > 0),
      chaptersRead: 0
    }
  }
}

export function buildLibraryCollection(rows, options = {}) {
  const continuityByMediaId = options.continuityByMediaId || {}
  const continueWatchingList = buildContinueWatchingList(rows, continuityByMediaId)
  const continueWatchingMediaIds = new Set(continueWatchingList.map((entry) => String(entry.mediaId)))
  const streamAnime = continueWatchingList.map((entry) => entry.media)
  const streamListData = Object.fromEntries(rows
    .filter((row) => continueWatchingMediaIds.has(String(row.media_id)))
    .map((row) => {
      const media = parseMedia(row)
      const continuity = getContinuityForMedia(continuityByMediaId, row.media_id)
      const activeContinuity = isContinueWatchingEligible(row, continuity, media) ? continuity : null
      return [
        String(row.media_id),
        {
          ...buildEntryListData(row),
          continuity: activeContinuity,
          ...buildPlaybackProgressFields(activeContinuity),
        }
      ]
    }))

  return {
    continueWatchingList,
    lists: ["CURRENT", "PAUSED", "PLANNING", "COMPLETED", "DROPPED"].map((status) => ({
      type: status,
      status,
      entries: rows
        .filter((row) => normalizeStatus(row.status) === status)
        .map((row) => {
          const media = parseMedia(row)
          const continuity = getContinuityForMedia(continuityByMediaId, row.media_id)
          const activeContinuity = isContinueWatchingEligible(row, continuity, media) ? continuity : null
          return {
          media,
          mediaId: row.media_id,
          listData: {
            ...buildEntryListData(row),
            continuity: activeContinuity,
            ...buildPlaybackProgressFields(activeContinuity),
          },
          libraryData: {
            allFilesLocked: false,
            sharedPath: "",
            unwatchedCount: calculateUnwatchedCount(row),
            mainFileCount: 0
          }
        }
        })
    })).filter((list) => list.entries.length > 0),
    unmatchedLocalFiles: [],
    unmatchedGroups: [],
    ignoredLocalFiles: [],
    unknownGroups: [],
    stats: {
      totalEntries: rows.length,
      totalFiles: 0,
      totalShows: rows.filter((row) => parseMedia(row)?.format === "TV").length,
      totalMovies: rows.filter((row) => parseMedia(row)?.format === "MOVIE").length,
      totalSpecials: rows.filter((row) => parseMedia(row)?.format === "SPECIAL").length,
      totalSize: "0 B"
    },
    stream: {
      continueWatchingList,
      anime: streamAnime,
      listData: streamListData,
    }
  }
}

export function buildAnimeEntry(row, options = {}) {
  const media = parseMedia(row)
  const progress = Number(row.progress || 0)
  const continuity = normalizeContinuityItem(options.continuity || null)
  return {
    mediaId: row.media_id,
    media,
    listData: {
      ...buildEntryListData(row),
      continuity,
      ...buildPlaybackProgressFields(continuity),
    },
    libraryData: undefined,
    downloadInfo: buildDownloadInfo(media, progress),
    episodes: [],
    nextEpisode: null,
    localFiles: [],
    anidbId: 0,
    currentEpisodeCount: Math.max(progress, Number(continuity?.episodeNumber || 0)),
    playbackProgress: buildPlaybackProgressFields(continuity),
    continuity,
    _isNakamaEntry: false
  }
}

export function buildRemoteAnimeEntry(media, options = {}) {
  const continuity = normalizeContinuityItem(options.continuity || null)
  return {
    mediaId: media.id,
    media,
    listData: {
      progress: 0,
      score: 0,
      status: "PLANNING",
      repeat: 0,
      startedAt: undefined,
      completedAt: undefined,
      continuity,
      ...buildPlaybackProgressFields(continuity),
    },
    libraryData: undefined,
    downloadInfo: buildDownloadInfo(media, 0),
    episodes: [],
    nextEpisode: null,
    localFiles: [],
    anidbId: 0,
    currentEpisodeCount: Number(continuity?.episodeNumber || 0),
    playbackProgress: buildPlaybackProgressFields(continuity),
    continuity,
    _isNakamaEntry: false
  }
}

export function buildLocalStats(rows) {
  const animeStats = {
    count: rows.length,
    minutesWatched: sum(rows, (row) => Number(row.progress || 0) * Number(parseMedia(row)?.duration || 0)),
    episodesWatched: sum(rows, (row) => Number(row.progress || 0)),
    meanScore: average(rows.filter((row) => Number(row.score || 0) > 0), (row) => Number(row.score || 0)),
    genres: buildGroupedStats(rows, (row) => parseMedia(row)?.genres || []),
    formats: buildGroupedStats(rows, (row) => [parseMedia(row)?.format].filter(Boolean), "format"),
    statuses: buildGroupedStats(rows, (row) => [normalizeStatus(row.status)], "status"),
    studios: [],
    scores: buildGroupedStats(rows.filter((row) => Number(row.score || 0) > 0), (row) => [Number(row.score || 0)], "score"),
    startYears: buildGroupedStats(rows, (row) => [parseMedia(row)?.startDate?.year].filter(Boolean), "startYear"),
    releaseYears: buildGroupedStats(rows, (row) => [parseMedia(row)?.seasonYear || parseMedia(row)?.startDate?.year].filter(Boolean), "releaseYear")
  }

  return {
    animeStats,
    mangaStats: {
      count: 0,
      chaptersRead: 0,
      meanScore: 0,
      genres: [],
      statuses: [],
      scores: [],
      startYears: [],
      releaseYears: []
    }
  }
}

function buildAnimeListEntry(row) {
  return {
    id: row.media_id,
    media: parseMedia(row),
    progress: Number(row.progress || 0),
    repeat: Number(row.repeat_count || 0),
    score: Number(row.score || 0),
    status: normalizeStatus(row.status),
    startedAt: isoToFuzzyDate(row.started_at),
    completedAt: isoToFuzzyDate(row.completed_at),
    private: false,
    notes: ""
  }
}

function buildEntryListData(row) {
  return {
    progress: Number(row.progress || 0),
    score: Number(row.score || 0),
    status: normalizeStatus(row.status),
    repeat: Number(row.repeat_count || 0),
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined
  }
}

function buildContinueWatchingList(rows, continuityByMediaId) {
  return rows
    .map((row) => {
      const media = parseMedia(row)
      const continuity = getContinuityForMedia(continuityByMediaId, row.media_id)
      if (!media || !continuity || !isContinueWatchingEligible(row, continuity, media)) {
        return null
      }

      return {
        media,
        mediaId: row.media_id,
        listData: {
          ...buildEntryListData(row),
          continuity,
          ...buildPlaybackProgressFields(continuity),
        },
        ...buildPlaybackProgressFields(continuity),
        continuity,
      }
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right.continuity.timeUpdated || 0).getTime() - new Date(left.continuity.timeUpdated || 0).getTime())
}

function isContinueWatchingEligible(row, continuity, media) {
  if (!continuity || typeof continuity !== "object") {
    return false
  }

  const status = normalizeStatus(row.status)
  if (status !== "CURRENT") {
    return false
  }

  const currentTime = Number(continuity.currentTime || 0)
  const duration = Number(continuity.duration || 0)
  if (!(currentTime > 0) || !(duration > 0)) {
    return false
  }

  if (currentTime >= duration - 3) {
    return false
  }

  const totalEpisodes = Number(media?.episodes || 0)
  const listProgress = Number(row.progress || 0)
  const continuityEpisode = Number(continuity.episodeNumber || 0)
  if (totalEpisodes > 0) {
    if (listProgress >= totalEpisodes) {
      return false
    }
    if (continuityEpisode > totalEpisodes) {
      return false
    }
  }

  return true
}

function getContinuityForMedia(continuityByMediaId, mediaId) {
  if (!continuityByMediaId || typeof continuityByMediaId !== "object") {
    return null
  }

  return normalizeContinuityItem(
    continuityByMediaId[mediaId] ||
    continuityByMediaId[String(mediaId)] ||
    null
  )
}

function normalizeContinuityItem(item) {
  if (!item || typeof item !== "object") {
    return null
  }

  const episodeNumber = Number(item.episodeNumber || 0)
  const currentTime = Number(item.currentTime || 0)
  const duration = Number(item.duration || 0)
  if (!episodeNumber || !(currentTime > 0) || !(duration > 0)) {
    return null
  }

  const progress = Math.max(0, Math.min(100, (currentTime / duration) * 100))
  return {
    kind: String(item.kind || "onlinestream"),
    filepath: String(item.filepath || ""),
    mediaId: Number(item.mediaId || 0),
    episodeNumber,
    currentTime,
    duration,
    progress,
    timeAdded: item.timeAdded,
    timeUpdated: item.timeUpdated,
  }
}

function buildPlaybackProgressFields(continuity) {
  if (!continuity || typeof continuity !== "object") {
    return {
      playbackProgress: null,
      episodeProgress: null,
      progressPercent: 0,
      currentTime: 0,
      duration: 0,
      episodeNumber: 0,
    }
  }

  const payload = {
    currentTime: Number(continuity.currentTime || 0),
    duration: Number(continuity.duration || 0),
    progress: Number(continuity.progress || 0),
    progressPercent: Number(continuity.progress || 0),
    episodeNumber: Number(continuity.episodeNumber || 0),
  }

  return {
    playbackProgress: payload,
    episodeProgress: payload,
    progressPercent: payload.progressPercent,
    currentTime: payload.currentTime,
    duration: payload.duration,
    episodeNumber: payload.episodeNumber,
  }
}

function parseMedia(row) {
  return typeof row.media_json === "string" ? JSON.parse(row.media_json) : row.media_json
}

function isoToFuzzyDate(value) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  }
}

function normalizeStatus(status) {
  return LIST_STATUSES.includes(status) ? status : "PLANNING"
}

function calculateUnwatchedCount(row) {
  const media = parseMedia(row)
  const episodes = Number(media?.episodes || 0)
  const progress = Number(row.progress || 0)
  if (!episodes) return 0
  return Math.max(episodes - progress, 0)
}

function buildDownloadInfo(media, progress) {
  const totalEpisodes = Number(media?.episodes || 0)
  const safeProgress = Number(progress || 0)
  const episodesToDownload = []

  for (let episodeNumber = safeProgress + 1; episodeNumber <= totalEpisodes; episodeNumber += 1) {
    episodesToDownload.push({
      episodeNumber,
      aniDBEpisode: String(episodeNumber),
      episode: {
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
      }
    })
  }

  return {
    episodesToDownload,
    canBatch: false,
    batchAll: false,
    hasInaccurateSchedule: false,
    rewatch: false,
    absoluteOffset: 0
  }
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0)
}

function average(rows, selector) {
  if (!rows.length) return 0
  return Math.round((sum(rows, selector) / rows.length) * 100) / 100
}

function buildGroupedStats(rows, valuesSelector, keyName = "genre") {
  const map = new Map()

  for (const row of rows) {
    const values = valuesSelector(row)
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue
      const key = String(value)
      if (!map.has(key)) {
        map.set(key, [])
      }
      map.get(key).push(row)
    }
  }

  return Array.from(map.entries())
    .map(([key, groupedRows]) => {
      const payload = {
        meanScore: average(groupedRows.filter((row) => Number(row.score || 0) > 0), (row) => Number(row.score || 0)),
        count: groupedRows.length,
        minutesWatched: sum(groupedRows, (row) => Number(row.progress || 0) * Number(parseMedia(row)?.duration || 0)),
        mediaIds: groupedRows.map((row) => row.media_id),
        chaptersRead: 0
      }
      if (keyName === "score" || keyName === "startYear" || keyName === "releaseYear") {
        payload[keyName] = Number(key)
      } else {
        payload[keyName] = key
      }
      return payload
    })
    .sort((a, b) => b.count - a.count)
}

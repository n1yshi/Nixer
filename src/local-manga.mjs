const LIST_STATUSES = ["CURRENT", "PAUSED", "PLANNING", "COMPLETED", "DROPPED", "REPEATING"]

export function buildMangaCollection(rows) {
  const safeRows = Array.isArray(rows) ? rows : []
  const chaptersRead = safeRows.reduce((total, row) => total + Number(row?.progress || 0), 0)

  return {
    MediaListCollection: {
      lists: LIST_STATUSES.map((status) => ({
        name: status,
        status,
        isCustomList: false,
        entries: safeRows
          .filter((row) => normalizeStatus(row?.status) === status)
          .map(buildMangaListEntry)
      })).filter((list) => list.entries.length > 0),
      chaptersRead
    }
  }
}

export function buildLocalMangaCollection(rows) {
  const safeRows = Array.isArray(rows) ? rows : []

  return {
    lists: ["CURRENT", "PAUSED", "PLANNING", "COMPLETED", "DROPPED"].map((status) => ({
      type: status,
      status,
      entries: safeRows
        .filter((row) => normalizeStatus(row?.status) === status)
        .map((row) => ({
          media: parseMedia(row),
          mediaId: row.media_id,
          listData: {
            progress: Number(row.progress || 0),
            score: Number(row.score || 0),
            status: normalizeStatus(row.status),
            repeat: Number(row.repeat_count || 0),
            startedAt: row.started_at || undefined,
            completedAt: row.completed_at || undefined,
          }
        }))
    })).filter((list) => list.entries.length > 0)
  }
}

function buildMangaListEntry(row) {
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

function parseMedia(row) {
  return typeof row.media_json === "string" ? JSON.parse(row.media_json) : row.media_json
}

function normalizeStatus(status) {
  return LIST_STATUSES.includes(status) ? status : "PLANNING"
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

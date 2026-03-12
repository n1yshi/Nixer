const ANIMAP_BASE_URL = process.env.NIXER_ANIMAP_URL || "https://anime.clap.ing"
const ANIZIP_BASE_URL = "https://api.ani.zip/v1/episodes"
const CACHE_TTL_MS = 60 * 60 * 1000
const requestCache = new Map()

export async function getAnimeEpisodeMetadata(mediaId) {
  const normalizedId = Number(mediaId)
  if (!normalizedId) {
    return null
  }

  const cacheKey = `anilist:${normalizedId}`
  const cached = requestCache.get(cacheKey)
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data
  }

  const metadata = await fetchAnimeMetadata(normalizedId)
  requestCache.set(cacheKey, {
    timestamp: Date.now(),
    data: metadata
  })
  return metadata
}

async function fetchAnimeMetadata(mediaId) {
  try {
    const animap = await fetchAnimapMedia(mediaId)
    const normalized = normalizeAnimapMetadata(animap)
    if (normalized?.episodesByNumber.size) {
      return normalized
    }
  } catch {
  }

  try {
    const anizip = await fetchAniZipMedia(mediaId)
    const normalized = normalizeAniZipMetadata(anizip)
    if (normalized?.episodesByNumber.size) {
      return normalized
    }
  } catch {
  }

  return null
}

async function fetchAnimapMedia(mediaId) {
  const url = `${ANIMAP_BASE_URL}/entry?anilist_id=${mediaId}`
  const response = await fetchJson(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "NixerNodeFull/1.0"
    }
  })

  if (!response.ok) {
    throw new Error(`animap request failed with ${response.status}`)
  }

  return response.json()
}

async function fetchAniZipMedia(mediaId) {
  const url = `${ANIZIP_BASE_URL}?anilist_id=${mediaId}`
  const response = await fetchJson(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "NixerNodeFull/1.0"
    }
  })

  if (!response.ok) {
    throw new Error(`anizip request failed with ${response.status}`)
  }

  return response.json()
}

async function fetchJson(url, options) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeAnimapMetadata(payload) {
  const episodesByNumber = new Map()
  const episodes = payload?.episodes && typeof payload.episodes === "object"
    ? Object.entries(payload.episodes)
    : []

  for (const [episodeKey, episode] of episodes) {
    const episodeNumber = Number(episode?.number || extractEpisodeInteger(episodeKey))
    if (!episodeNumber || episodesByNumber.has(episodeNumber)) {
      continue
    }

    episodesByNumber.set(episodeNumber, {
      title: String(episode?.tvdbTitle || episode?.anidbTitle || "").trim(),
      image: String(episode?.image || "").trim(),
      summary: String(episode?.overview || "").trim(),
      overview: String(episode?.overview || "").trim(),
      isFiller: false,
      hasImage: Boolean(episode?.image),
      anidbId: Number(episode?.anidbEid || 0),
      tvdbId: Number(episode?.tvdbEid || 0)
    })
  }

  return {
    source: "animap",
    episodesByNumber
  }
}

function normalizeAniZipMetadata(payload) {
  const episodesByNumber = new Map()
  const episodes = payload?.episodes && typeof payload.episodes === "object"
    ? Object.entries(payload.episodes)
    : []

  for (const [episodeKey, episode] of episodes) {
    const episodeNumber = Number(episode?.episodeNumber || extractEpisodeInteger(episodeKey))
    if (!episodeNumber || episodesByNumber.has(episodeNumber)) {
      continue
    }

    episodesByNumber.set(episodeNumber, {
      title: pickAniZipTitle(episode?.title),
      image: String(episode?.image || "").trim(),
      summary: String(episode?.summary || episode?.overview || "").trim(),
      overview: String(episode?.overview || episode?.summary || "").trim(),
      isFiller: false,
      hasImage: Boolean(episode?.image),
      anidbId: Number(episode?.anidbEid || 0),
      tvdbId: Number(episode?.tvdbEid || 0)
    })
  }

  return {
    source: "anizip",
    episodesByNumber
  }
}

function pickAniZipTitle(titleMap) {
  if (!titleMap || typeof titleMap !== "object") {
    return ""
  }

  return String(
    titleMap.en ||
    titleMap["x-jat"] ||
    titleMap.ja ||
    Object.values(titleMap).find(Boolean) ||
    ""
  ).trim()
}

function extractEpisodeInteger(value) {
  const match = String(value || "").match(/[0-9]+/)
  return Number.parseInt(match?.[0] || "", 10) || 0
}

import { logWarn } from "./logging.mjs"

const ANILIST_API_URL = "https://graphql.anilist.co"
const requestCache = new Map()
const pendingRequests = new Map()

const TTL = {
  listAnime: 5 * 60 * 1000,
  listRecentAnime: 2 * 60 * 1000,
  animeDetails: 12 * 60 * 60 * 1000,
  listManga: 5 * 60 * 1000,
  mangaDetails: 12 * 60 * 60 * 1000
}

const BASE_ANIME_FIELDS = `
  id
  idMal
  siteUrl
  status
  season
  type
  format
  seasonYear
  bannerImage
  episodes
  synonyms
  isAdult
  countryOfOrigin
  meanScore
  description(asHtml: false)
  genres
  duration
  trailer {
    id
    site
    thumbnail
  }
  title {
    english
    native
    romaji
    userPreferred
  }
  coverImage {
    color
    extraLarge
    large
    medium
  }
  startDate {
    day
    month
    year
  }
  endDate {
    day
    month
    year
  }
  nextAiringEpisode {
    airingAt
    episode
    timeUntilAiring
  }
`

const BASE_MANGA_FIELDS = `
  id
  idMal
  siteUrl
  status
  type
  format
  chapters
  volumes
  synonyms
  isAdult
  countryOfOrigin
  meanScore
  description(asHtml: false)
  genres
  title {
    english
    native
    romaji
    userPreferred
  }
  coverImage {
    color
    extraLarge
    large
    medium
  }
  startDate {
    day
    month
    year
  }
  endDate {
    day
    month
    year
  }
`

export async function listAnime(variables) {
  const normalizedVariables = normalizeListAnimeVariables(variables)
  const query = `
    query ListAnime(
      $page: Int,
      $perPage: Int,
      $search: String,
      $sort: [MediaSort],
      $status: [MediaStatus],
      $genres: [String],
      $averageScore_greater: Int,
      $season: MediaSeason,
      $seasonYear: Int,
      $format: MediaFormat,
      $isAdult: Boolean,
      $countryOfOrigin: CountryCode
    ) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          currentPage
          hasNextPage
          lastPage
          perPage
          total
        }
        media(
          type: ANIME
          search: $search
          sort: $sort
          status_in: $status
          genre_in: $genres
          averageScore_greater: $averageScore_greater
          season: $season
          seasonYear: $seasonYear
          format: $format
          isAdult: $isAdult
          countryOfOrigin: $countryOfOrigin
        ) {
          ${BASE_ANIME_FIELDS}
        }
      }
    }
  `

  const data = await sendAniListCachedQuery({
    cacheKey: `listAnime:${stableStringify(normalizedVariables)}`,
    ttlMs: TTL.listAnime,
    query,
    variables: normalizedVariables
  })
  return data
}

export async function listManga(variables) {
  const normalizedVariables = normalizeListAnimeVariables(variables)
  const query = `
    query ListManga(
      $page: Int,
      $perPage: Int,
      $search: String,
      $sort: [MediaSort],
      $status: [MediaStatus],
      $genres: [String],
      $averageScore_greater: Int,
      $season: MediaSeason,
      $seasonYear: Int,
      $format: MediaFormat,
      $isAdult: Boolean,
      $countryOfOrigin: CountryCode
    ) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          currentPage
          hasNextPage
          lastPage
          perPage
          total
        }
        media(
          type: MANGA
          search: $search
          sort: $sort
          status_in: $status
          genre_in: $genres
          averageScore_greater: $averageScore_greater
          season: $season
          seasonYear: $seasonYear
          format: $format
          isAdult: $isAdult
          countryOfOrigin: $countryOfOrigin
        ) {
          ${BASE_MANGA_FIELDS}
        }
      }
    }
  `

  const data = await sendAniListCachedQuery({
    cacheKey: `listManga:${stableStringify(normalizedVariables)}`,
    ttlMs: TTL.listManga,
    query,
    variables: normalizedVariables
  })
  return data
}

export async function getAnimeDetails(mediaId) {
  const variables = { id: Number(mediaId) }
  try {
    const data = await sendAniListCachedQuery({
      cacheKey: `animeDetails:${variables.id}:streaming`,
      ttlMs: TTL.animeDetails,
      query: buildMediaDetailsQuery({ includeStreamingEpisodes: true }),
      variables
    })
    return data?.Media || null
  } catch (error) {
    if (!shouldFallbackAnimeDetailsQuery(error)) {
      throw error
    }

    logWarn("anilist", `Falling back to media details without streamingEpisodes for ${variables.id}`)

    const data = await sendAniListCachedQuery({
      cacheKey: `animeDetails:${variables.id}:base`,
      ttlMs: TTL.animeDetails,
      query: buildMediaDetailsQuery({ includeStreamingEpisodes: false }),
      variables
    })

    return data?.Media
      ? {
        ...data.Media,
        streamingEpisodes: []
      }
      : null
  }
}

export async function getMangaDetails(mediaId) {
  const variables = { id: Number(mediaId) }
  const query = `
    query MangaDetails($id: Int) {
      Media(id: $id, type: MANGA) {
        ${BASE_MANGA_FIELDS}
      }
    }
  `

  const data = await sendAniListCachedQuery({
    cacheKey: `mangaDetails:${variables.id}`,
    ttlMs: TTL.mangaDetails,
    query,
    variables
  })

  return data?.Media || null
}

export async function listRecentAnime(variables) {
  const normalizedVariables = {
    page: Number(variables?.page || 1),
    perPage: Number(variables?.perPage || 20),
    airingAt_greater: variables?.airingAt_greater || undefined,
    airingAt_lesser: variables?.airingAt_lesser || undefined,
    notYetAired: Boolean(variables?.notYetAired)
  }
  const query = `
    query ListRecentAnime(
      $page: Int,
      $perPage: Int,
      $airingAt_greater: Int,
      $airingAt_lesser: Int,
      $notYetAired: Boolean = false
    ) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          currentPage
          hasNextPage
          lastPage
          perPage
          total
        }
        airingSchedules(
          airingAt_greater: $airingAt_greater
          airingAt_lesser: $airingAt_lesser
          notYetAired: $notYetAired
          sort: [TIME]
        ) {
          id
          airingAt
          timeUntilAiring
          episode
          media {
            ${BASE_ANIME_FIELDS}
          }
        }
      }
    }
  `

  const data = await sendAniListCachedQuery({
    cacheKey: `listRecentAnime:${stableStringify(normalizedVariables)}`,
    ttlMs: TTL.listRecentAnime,
    query,
    variables: normalizedVariables
  })
  return data
}

async function sendAniListCachedQuery({ cacheKey, ttlMs, query, variables }) {
  const now = Date.now()
  const cached = requestCache.get(cacheKey)

  if (cached && (now - cached.timestamp) < ttlMs) {
    return cached.data
  }

  const pending = pendingRequests.get(cacheKey)
  if (pending) {
    return pending
  }

  const requestPromise = sendAniListQuery(query, variables)
    .then((data) => {
      requestCache.set(cacheKey, {
        data,
        timestamp: Date.now()
      })
      return data
    })
    .catch((error) => {
      if (isAniListRateLimitError(error) && cached?.data) {
        logWarn("anilist cache", `Using stale cache for ${cacheKey} after rate limit`)
        return cached.data
      }
      throw error
    })
    .finally(() => {
      pendingRequests.delete(cacheKey)
    })

  pendingRequests.set(cacheKey, requestPromise)
  return requestPromise
}

async function sendAniListQuery(query, variables) {
  const response = await fetch(ANILIST_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({ query, variables })
  })

  const rawText = await response.text()
  let json = null
  try {
    json = rawText ? JSON.parse(rawText) : null
  } catch {
    json = null
  }

  if (!response.ok || json?.errors?.length) {
    const message = json?.errors?.[0]?.message
      ? String(json.errors[0].message)
      : `AniList request failed with ${response.status}`
    const error = new Error(message)
    error.statusCode = response.status
    if (!json && rawText) {
      error.detail = rawText.slice(0, 400)
    }
    throw error
  }

  return json?.data
}

function buildMediaDetailsQuery({ includeStreamingEpisodes }) {
  const streamingEpisodesFields = includeStreamingEpisodes
    ? `
        streamingEpisodes {
          title
          thumbnail
          url
          site
        }
      `
    : ""

  return `
    query MediaDetails($id: Int) {
      Media(id: $id, type: ANIME) {
        ${BASE_ANIME_FIELDS}
        ${streamingEpisodesFields}
      }
    }
  `
}

function shouldFallbackAnimeDetailsQuery(error) {
  const statusCode = Number(error?.statusCode || 0)
  const message = String(error?.message || "")
  return statusCode >= 500 || message.includes("500")
}

function isAniListRateLimitError(error) {
  const message = String(error?.message || "")
  return error?.statusCode === 429 || message.includes("Too Many Requests")
}

function normalizeListAnimeVariables(variables = {}) {
  return {
    page: Number(variables.page || 1),
    perPage: Number(variables.perPage || 20),
    search: variables.search || undefined,
    sort: Array.isArray(variables.sort) && variables.sort.length > 0 ? variables.sort : ["TRENDING_DESC"],
    status: Array.isArray(variables.status) && variables.status.length > 0 ? variables.status : undefined,
    genres: Array.isArray(variables.genres) && variables.genres.length > 0 ? variables.genres : undefined,
    averageScore_greater: variables.averageScore_greater || undefined,
    season: variables.season || undefined,
    seasonYear: variables.seasonYear || variables.year || undefined,
    format: variables.format || undefined,
    isAdult: Boolean(variables.isAdult),
    countryOfOrigin: variables.countryOfOrigin || undefined
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

import vm from "node:vm"
import { createRequire } from "node:module"
import path from "node:path"

import { getAnimeDetails } from "./anilist-client.mjs"
import { getAnimeEpisodeMetadata } from "./anime-metadata.mjs"
import { getAllExtensions, getExtensionUserConfig, getInstalledExtensionById } from "./extensions-repo.mjs"

const providerCache = new Map()
const searchCache = new Map()
const episodeCache = new Map()
const require = createRequire(import.meta.url)
let esbuildTransformSync = null

export async function getOnlineStreamEpisodeList(config, mediaId, providerId, dubbed) {
  if (!providerId) {
    return {
      media: await getAnimeDetails(mediaId),
      episodes: []
    }
  }

  const media = await getAnimeDetails(mediaId)
  if (!media) {
    throw new Error("anime not found")
  }

  const provider = await getProviderInstance(config, providerId)
  const result = await searchProvider(provider, media, dubbed)
  if (!result) {
    return { media, episodes: [] }
  }

  let providerEpisodes = []
  try {
    providerEpisodes = await findEpisodes(config, provider, providerId, result.id, dubbed)
  } catch {
    return { media, episodes: [] }
  }
  const animeMetadata = await getAnimeEpisodeMetadata(media.id).catch(() => null)
  const streamingMetadataByNumber = getStreamingEpisodeMetadataByNumber(media)
  const episodes = providerEpisodes.map((episode) => ({
    number: Number(episode.number || 0),
    title: getEpisodeListTitle(
      episode,
      animeMetadata?.episodesByNumber?.get(Number(episode.number || 0)),
      streamingMetadataByNumber.get(Number(episode.number || 0))
    ),
    image: getEpisodeListImage(
      media,
      animeMetadata?.episodesByNumber?.get(Number(episode.number || 0)),
      streamingMetadataByNumber.get(Number(episode.number || 0))
    ),
    description: getEpisodeListDescription(
      animeMetadata?.episodesByNumber?.get(Number(episode.number || 0))
    ),
    isFiller: Boolean(animeMetadata?.episodesByNumber?.get(Number(episode.number || 0))?.isFiller)
  }))

  return { media, episodes }
}

export async function getOnlineStreamEpisodeSource(config, mediaId, providerId, episodeNumber, dubbed) {
  const media = await getAnimeDetails(mediaId)
  if (!media) {
    throw new Error("anime not found")
  }

  const provider = await getProviderInstance(config, providerId)
  const result = await searchProvider(provider, media, dubbed)
  if (!result) {
    throw new Error("provider search returned no result")
  }

  const providerEpisodes = await findEpisodes(config, provider, providerId, result.id, dubbed)
  const episode = selectEpisodeByNumber(providerEpisodes, episodeNumber)
  if (!episode) {
    throw new Error("episode not found")
  }
  const sourceEpisode = prepareEpisodeForSourceRequest(episode, providerId, dubbed)
  if (!sourceEpisode) {
    throw new Error("dubbed episode not available")
  }

  const settings = safeGetSettings(provider)
  const requestedServers = Array.isArray(settings.episodeServers) && settings.episodeServers.length
    ? settings.episodeServers
    : ["default"]

  const videoSources = []
  for (const serverName of requestedServers) {
    try {
      const server = await provider.findEpisodeServer(sourceEpisode, serverName)
      for (const source of server?.videoSources || []) {
        videoSources.push({
          server: server.server || serverName,
          headers: server.headers || {},
          url: source.url,
          label: source.label || "",
          quality: source.quality || "auto",
          type: source.type || "unknown",
          subtitles: Array.isArray(source.subtitles)
            ? source.subtitles.map((subtitle) => ({
              url: subtitle.url,
              language: subtitle.language || "Unknown"
            }))
            : []
        })
      }
    } catch {
    }
  }

  if (!videoSources.length) {
    throw new Error("no video sources found")
  }

  return {
    number: Number(episode.number || episodeNumber),
    videoSources
  }
}

export async function listRuntimeOnlinestreamProviderExtensions(config) {
  const installedExtensions = getAllExtensions(config).extensions
    .filter((extension) => extension.type === "onlinestream-provider")

  const providers = []

  for (const extension of installedExtensions) {
    let settings = {}

    try {
      const provider = await getProviderInstance(config, extension.id)
      settings = safeGetSettings(provider)
    } catch {
    }

    providers.push({
      id: extension.id,
      name: extension.name,
      lang: extension.lang || "en",
      episodeServers: Array.isArray(settings.episodeServers) ? settings.episodeServers : [],
      supportsDub: Boolean(settings.supportsDub)
    })
  }

  return providers
}

async function getProviderInstance(config, providerId) {
  const cacheKey = `${config.extensionsDir}:${providerId}`
  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)
  }

  const extension = getInstalledExtensionById(config, providerId)
  if (!extension || extension.type !== "onlinestream-provider") {
    throw new Error("onlinestream provider not installed")
  }

  const resolvedPayload = applyUserConfig(extension, getExtensionUserConfig(config, providerId))
  const source = transpileProviderSource(resolvedPayload)

  const context = vm.createContext({
    console,
    fetch,
    URL,
    Buffer,
    setTimeout,
    clearTimeout,
    structuredClone
  })

  const script = new vm.Script(`${source}\n;globalThis.__NIXER_PROVIDER_CLASS__ = Provider;`, {
    filename: `${providerId}.js`
  })
  script.runInContext(context, { timeout: 30000 })

  const ProviderCtor = context.__NIXER_PROVIDER_CLASS__
  if (typeof ProviderCtor !== "function") {
    throw new Error("provider class not found")
  }

  const provider = new ProviderCtor()
  provider.__nixerProviderId = providerId
  providerCache.set(cacheKey, provider)
  return provider
}

function applyUserConfig(extension, configResponse) {
  const fields = extension.userConfig?.fields || []
  const savedValues = configResponse?.savedUserConfig?.values || {}
  let payload = extension.payload || ""

  for (const field of fields) {
    const value = savedValues[field.name] ?? field.default ?? ""
    payload = payload.replaceAll(`{{${field.name}}}`, String(value))
  }

  return payload
}

function transpileProviderSource(source) {
  const input = String(source || "")
  const esbuildCode = transpileWithEsbuild(input)
  if (esbuildCode) {
    return esbuildCode
  }

  let code = input
  code = code.replace(/\/\/\/ <reference[^\n]*\n/g, "")
  code = code.replace(/\b(public|private|protected|readonly)\s+/g, "")
  code = code.replace(/(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([^=;]+)(?=\s*=)/g, "$1 $2")
  code = code.replace(/\)\s+as\s+[^;\n]+/g, ")")
  code = code.replace(/\]\s+as\s+[^;\n]+/g, "]")
  code = code.replace(/\}\s+as\s+[^;\n]+/g, "}")
  code = code.replace(/\b(?:type|interface)\s+[A-Za-z_$][\w$]*(?:\s*<[^>\n]+>)?\s*=\s*[\s\S]*?^\}/gm, "")
  code = code.replace(/\binterface\s+[A-Za-z_$][\w$]*(?:\s*<[^>\n]+>)?\s*\{[\s\S]*?^\}/gm, "")
  code = code.replace(/^(\s*async\s+function\s+[A-Za-z_$][\w$]*)\(([^)]*)\)\s*:\s*[^({=\n]+(?:<[^>\n]+>)?\s*\{/gm, (_m, prefix, params) => {
    return `${prefix}(${stripTypedParameters(params)}) {`
  })
  code = code.replace(/^(\s*function\s+[A-Za-z_$][\w$]*)\(([^)]*)\)\s*:\s*[^({=\n]+(?:<[^>\n]+>)?\s*\{/gm, (_m, prefix, params) => {
    return `${prefix}(${stripTypedParameters(params)}) {`
  })
  code = code.replace(/^(\s*async\s+function\s+[A-Za-z_$][\w$]*)\(([^)]*)\)\s*\{/gm, (_m, prefix, params) => {
    return `${prefix}(${stripTypedParameters(params)}) {`
  })
  code = code.replace(/^(\s*function\s+[A-Za-z_$][\w$]*)\(([^)]*)\)\s*\{/gm, (_m, prefix, params) => {
    return `${prefix}(${stripTypedParameters(params)}) {`
  })
  code = code.replace(/^(\s*async\s+[A-Za-z_$][\w$]*)\(([^)]*)\)\s*:\s*[^({=\n]+(?:<[^>\n]+>)?\s*\{/gm, (_m, prefix, params) => {
    return `${prefix}(${stripTypedParameters(params)}) {`
  })
  code = code.replace(/^(\s*[A-Za-z_$][\w$]*)\(([^)]*)\)\s*:\s*[^({=\n]+(?:<[^>\n]+>)?\s*\{/gm, (_m, prefix, params) => {
    return `${prefix}(${stripTypedParameters(params)}) {`
  })
  code = code.replace(/\(([^)]*)\)\s*:\s*[^=({\n]+(?:<[^>\n]+>)?\s*=>/g, (_m, params) => {
    return `(${stripTypedParameters(params)}) =>`
  })
  code = code.replace(/\(([^)]*)\)\s*=>/g, (_m, params) => {
    return `(${stripTypedParameters(params)}) =>`
  })
  code = code.replace(/<[^>\n]+>\s*(?=\()/g, "")
  return code
}

function transpileWithEsbuild(source) {
  const transformSync = getEsbuildTransformSync()
  if (!transformSync) {
    return null
  }

  try {
    const result = transformSync(source, {
      loader: "ts",
      target: "es2020",
      charset: "utf8",
      sourcemap: false,
      minify: false
    })
    return typeof result?.code === "string" ? result.code : null
  } catch {
    return null
  }
}

function getEsbuildTransformSync() {
  if (esbuildTransformSync) {
    return esbuildTransformSync
  }

  const candidates = [
    "esbuild",
    path.resolve(process.cwd(), "node_modules/esbuild")
  ]

  for (const candidate of candidates) {
    try {
      const esbuild = require(candidate)
      if (typeof esbuild?.transformSync === "function") {
        esbuildTransformSync = esbuild.transformSync
        return esbuildTransformSync
      }
    } catch {
    }
  }

  return null
}

function stripTypedParameters(params) {
  let output = ""
  let depthAngle = 0
  let depthBrace = 0
  let depthBracket = 0
  let inString = null

  for (let index = 0; index < params.length; index += 1) {
    const char = params[index]
    const next = params[index + 1]

    if (inString) {
      output += char
      if (char === "\\" && next) {
        output += next
        index += 1
        continue
      }
      if (char === inString) {
        inString = null
      }
      continue
    }

    if (char === "'" || char === "\"" || char === "`") {
      inString = char
      output += char
      continue
    }

    if (char === "<") {
      depthAngle += 1
      output += char
      continue
    }
    if (char === ">" && depthAngle > 0) {
      depthAngle -= 1
      output += char
      continue
    }
    if (char === "{") {
      depthBrace += 1
      output += char
      continue
    }
    if (char === "}" && depthBrace > 0) {
      depthBrace -= 1
      output += char
      continue
    }
    if (char === "[") {
      depthBracket += 1
      output += char
      continue
    }
    if (char === "]" && depthBracket > 0) {
      depthBracket -= 1
      output += char
      continue
    }

    if (char === ":" && depthAngle === 0 && depthBrace === 0 && depthBracket === 0) {
      let cursor = index + 1
      let localAngle = 0
      let localBrace = 0
      let localBracket = 0
      let localString = null

      while (cursor < params.length) {
        const current = params[cursor]
        const upcoming = params[cursor + 1]

        if (localString) {
          if (current === "\\" && upcoming) {
            cursor += 2
            continue
          }
          if (current === localString) {
            localString = null
          }
          cursor += 1
          continue
        }

        if (current === "'" || current === "\"" || current === "`") {
          localString = current
          cursor += 1
          continue
        }
        if (current === "<") {
          localAngle += 1
          cursor += 1
          continue
        }
        if (current === ">" && localAngle > 0) {
          localAngle -= 1
          cursor += 1
          continue
        }
        if (current === "{") {
          localBrace += 1
          cursor += 1
          continue
        }
        if (current === "}" && localBrace > 0) {
          localBrace -= 1
          cursor += 1
          continue
        }
        if (current === "[") {
          localBracket += 1
          cursor += 1
          continue
        }
        if (current === "]" && localBracket > 0) {
          localBracket -= 1
          cursor += 1
          continue
        }
        if (localAngle === 0 && localBrace === 0 && localBracket === 0 && (current === "," || current === ")")) {
          break
        }
        cursor += 1
      }

      index = cursor - 1
      continue
    }

    output += char
  }

  return output
}

function safeGetSettings(provider) {
  try {
    return provider.getSettings?.() || {}
  } catch {
    return {}
  }
}

async function searchProvider(provider, media, dubbed) {
  const providerId = String(provider?.__nixerProviderId || provider.constructor?.name || "provider")
  const cacheKey = `${providerId}:${media.id}:${dubbed ? "dub" : "sub"}`
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey)
  }

  const searchOptions = {
    media: {
      id: media.id,
      idMal: media.idMal || undefined,
      status: media.status || "NOT_YET_RELEASED",
      format: media.format || "TV",
      englishTitle: media.title?.english || undefined,
      romajiTitle: media.title?.romaji || "",
      episodeCount: Number(media.episodes || -1),
      synonyms: Array.isArray(media.synonyms) ? media.synonyms : [],
      isAdult: Boolean(media.isAdult),
      startDate: media.startDate || undefined
    },
    dub: Boolean(dubbed),
    year: Number(media.startDate?.year || 0)
  }

  const queryCandidates = uniqueNonEmpty([
    media.title?.romaji,
    media.title?.english,
    media.title?.native
  ])
  const results = []
  const seenIds = new Set()

  for (const query of queryCandidates) {
    try {
      const response = await provider.search({ ...searchOptions, query })
      for (const item of Array.isArray(response) ? response : []) {
        const key = String(item?.id || "")
        const subOrDub = normalizeSubOrDub(item?.subOrDub)
        const seenKey = `${key}:${subOrDub || "unknown"}`
        if (!key || seenIds.has(seenKey)) {
          continue
        }
        seenIds.add(seenKey)
        results.push({
          ...item,
          id: key,
          title: String(item?.title || ""),
          url: String(item?.url || ""),
          subOrDub
        })
      }
    } catch {
    }
  }

  const titles = uniqueNonEmpty([
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(Array.isArray(media.synonyms) ? media.synonyms : [])
  ])
  const item = getBestSearchResultForDubPreference(results, titles, dubbed)
  searchCache.set(cacheKey, item)
  return item
}

function uniqueNonEmpty(values) {
  return [...new Set(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )]
}

function getBestSearchResult(results, titles) {
  if (!Array.isArray(results) || !results.length || !Array.isArray(titles) || !titles.length) {
    return Array.isArray(results) && results.length ? results[0] : null
  }

  let bestItem = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const item of results) {
    const itemTitle = normalizeTitle(item?.title)
    if (!itemTitle) {
      continue
    }

    for (const title of titles) {
      const distance = levenshtein(itemTitle, normalizeTitle(title))
      if (distance < bestDistance) {
        bestDistance = distance
        bestItem = item
      }
    }
  }

  return bestItem || results[0] || null
}

function getBestSearchResultForDubPreference(results, titles, dubbed) {
  const preferredResults = Array.isArray(results)
    ? results.filter((item) => matchesDubPreference(item, dubbed))
    : []

  if (preferredResults.length) {
    return getBestSearchResult(preferredResults, titles)
  }

  return getBestSearchResult(results, titles)
}

function matchesDubPreference(item, dubbed) {
  const subOrDub = normalizeSubOrDub(item?.subOrDub)
  if (!subOrDub) {
    return true
  }

  if (dubbed) {
    return subOrDub === "dub" || subOrDub === "both"
  }

  return subOrDub === "sub" || subOrDub === "both"
}

function normalizeSubOrDub(value) {
  const normalized = String(value || "").trim().toLowerCase()
  if (normalized === "sub" || normalized === "dub" || normalized === "both") {
    return normalized
  }
  return ""
}

function getStreamingEpisodeMetadataByNumber(media) {
  const metadataByNumber = new Map()
  const streamingEpisodes = Array.isArray(media?.streamingEpisodes) ? media.streamingEpisodes : []

  for (const streamingEpisode of streamingEpisodes) {
    const episodeNumber = extractStreamingEpisodeNumber(streamingEpisode)
    if (!episodeNumber || metadataByNumber.has(episodeNumber)) {
      continue
    }

    metadataByNumber.set(episodeNumber, {
      title: String(streamingEpisode?.title || "").trim(),
      thumbnail: String(streamingEpisode?.thumbnail || "").trim()
    })
  }

  for (const [index, streamingEpisode] of streamingEpisodes.entries()) {
    const fallbackEpisodeNumber = index + 1
    if (metadataByNumber.has(fallbackEpisodeNumber)) {
      continue
    }

    metadataByNumber.set(fallbackEpisodeNumber, {
      title: String(streamingEpisode?.title || "").trim(),
      thumbnail: String(streamingEpisode?.thumbnail || "").trim()
    })
  }

  return metadataByNumber
}

function extractStreamingEpisodeNumber(streamingEpisode) {
  const title = String(streamingEpisode?.title || "").trim()
  const url = String(streamingEpisode?.url || "").trim()
  const candidates = [
    title.match(/\b(?:episode|ep)\s+(\d+)\b/i),
    title.match(/^(\d+)\b/),
    url.match(/[?&](?:ep|episode)=([0-9]+)/i),
    url.match(/(?:episode|ep)[-_/]([0-9]+)\b/i),
    url.match(/\/([0-9]+)(?:[/?#]|$)/)
  ]

  for (const match of candidates) {
    const value = Number.parseInt(match?.[1] || "", 10)
    if (Number.isFinite(value) && value > 0) {
      return value
    }
  }

  return null
}

function getEpisodeListTitle(episode, animeMetadata, streamingMetadata) {
  const providerTitle = String(episode?.title || "").trim()
  const animeMetadataTitle = String(animeMetadata?.title || "").trim()
  if (animeMetadataTitle) {
    return animeMetadataTitle
  }

  if (providerTitle && !isGenericEpisodeTitle(providerTitle, episode?.number)) {
    return providerTitle
  }

  const metadataTitle = String(streamingMetadata?.title || "").trim()
  if (metadataTitle) {
    return metadataTitle
  }

  return providerTitle || `Episode ${episode?.number || 0}`
}

function getEpisodeListImage(media, animeMetadata, streamingMetadata) {
  const resolvedImage = String(animeMetadata?.image || "").trim() ||
    String(streamingMetadata?.thumbnail || "").trim() ||
    media?.bannerImage ||
    media?.coverImage?.extraLarge ||
    media?.coverImage?.large ||
    media?.coverImage?.medium ||
    ""

  return toProxyImageUrl(resolvedImage)
}

function getEpisodeListDescription(animeMetadata) {
  return String(animeMetadata?.summary || animeMetadata?.overview || "").trim()
}

function toProxyImageUrl(value) {
  const url = String(value || "").trim()
  if (!url) {
    return ""
  }

  if (
    url.startsWith("/api/v1/proxy?url=") ||
    url.startsWith("/") ||
    url.startsWith("{{LOCAL_ASSETS}}") ||
    url.startsWith("data:") ||
    url.startsWith("blob:")
  ) {
    return url
  }

  if (!/^https?:\/\//i.test(url)) {
    return url
  }

  return `/api/v1/proxy?url=${encodeURIComponent(url)}`
}

function isGenericEpisodeTitle(title, episodeNumber) {
  const normalizedTitle = String(title || "").trim().toLowerCase()
  const normalizedNumber = String(Number(episodeNumber || 0))
  return normalizedTitle === `episode ${normalizedNumber}` ||
    normalizedTitle === `ep ${normalizedNumber}` ||
    normalizedTitle === `episode ${normalizedNumber}:` ||
    normalizedTitle.startsWith(`episode ${normalizedNumber} `)
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function levenshtein(a, b) {
  if (!a) return b.length
  if (!b) return a.length

  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index)
  const current = new Array(b.length + 1)

  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1
      current[col] = Math.min(
        current[col - 1] + 1,
        previous[col] + 1,
        previous[col - 1] + cost
      )
    }

    for (let col = 0; col <= b.length; col += 1) {
      previous[col] = current[col]
    }
  }

  return previous[b.length]
}

async function findEpisodes(config, provider, providerId, searchId, dubbed) {
  const cacheKey = `${config.extensionsDir}:${providerId}:${searchId}:${dubbed ? "dub" : "sub"}`
  if (episodeCache.has(cacheKey)) {
    return episodeCache.get(cacheKey)
  }

  const episodes = await provider.findEpisodes(searchId)
  const normalized = Array.isArray(episodes)
    ? episodes.map((episode) => ({
      provider: providerId,
      id: episode.id,
      number: Number(episode.number || 0),
      url: episode.url || "",
      title: episode.title || ""
    }))
    : []

  episodeCache.set(cacheKey, normalized)
  return normalized
}

function selectEpisodeByNumber(episodes, requestedNumber) {
  if (!Array.isArray(episodes) || !episodes.length) {
    return null
  }

  const target = Number(requestedNumber)
  const exact = episodes.find((item) => Number(item.number) === target)
  if (exact) {
    return exact
  }

  const sorted = [...episodes]
    .filter((item) => Number.isFinite(Number(item.number)))
    .sort((left, right) => Number(left.number) - Number(right.number))

  if (!sorted.length) {
    return null
  }

  if (sorted.length === 1) {
    return sorted[0]
  }

  if (target < Number(sorted[0].number)) {
    return sorted[0]
  }

  if (target > Number(sorted[sorted.length - 1].number)) {
    return sorted[sorted.length - 1]
  }

  return null
}

function prepareEpisodeForSourceRequest(episode, providerId, dubbed) {
  if (!episode || typeof episode !== "object") {
    return null
  }

  const nextEpisode = { ...episode }
  if (!dubbed) {
    return nextEpisode
  }

  if (isZoroProvider(providerId)) {
    const episodeId = String(nextEpisode.id || "")
    if (!episodeId) {
      return null
    }

    if (episodeId.endsWith("both")) {
      nextEpisode.id = `${episodeId.slice(0, -4)}dub`
      return nextEpisode
    }

    if (!episodeId.endsWith("dub")) {
      return null
    }
  }

  return nextEpisode
}

function isZoroProvider(providerId) {
  return String(providerId || "").trim().toLowerCase() === "zoro"
}

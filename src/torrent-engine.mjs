import vm from "node:vm"
import { createRequire } from "node:module"

import { getExtensionUserConfig, getInstalledExtensionById } from "./extensions-repo.mjs"

const providerCache = new Map()
let esbuildTransformSync = null
const require = createRequire(import.meta.url)
const LoadDoc = createLoadDoc()

export async function searchAnimeTorrents(config, providerId, options) {
  const provider = await getProviderInstance(config, providerId)
  const type = String(options?.type || "smart").toLowerCase()
  const query = String(options?.query || "").trim()
  const media = options?.media && typeof options.media === "object" ? options.media : {}

  const canSmartSearch = typeof provider.smartSearch === "function"
  const wantsSmartSearch = type === "smart"
  const shouldSmartSearch = wantsSmartSearch && canSmartSearch

  const raw = shouldSmartSearch
    ? await provider.smartSearch({
      media,
      query,
      batch: Boolean(options?.batch),
      episodeNumber: Number(options?.episodeNumber || 0) || 0,
      resolution: String(options?.resolution || ""),
      anidbAID: Number(options?.anidbAID || 0) || 0,
      anidbEID: Number(options?.anidbEID || 0) || 0,
      bestReleases: Boolean(options?.bestRelease),
    })
    : await provider.search({ media, query })

  const list = Array.isArray(raw) ? raw : []
  return list.map((torrent) => normalizeAnimeTorrent(torrent, providerId)).filter((torrent) => torrent.name)
}

export async function getTorrentMagnetLink(config, providerId, torrent) {
  if (torrent?.magnetLink) {
    return String(torrent.magnetLink)
  }
  const provider = await getProviderInstance(config, providerId)
  if (typeof provider.getTorrentMagnetLink !== "function") {
    throw new Error("provider does not support getTorrentMagnetLink")
  }
  const value = await provider.getTorrentMagnetLink(torrent)
  return String(value || "")
}

export async function getTorrentInfoHash(config, providerId, torrent) {
  if (torrent?.infoHash) {
    return String(torrent.infoHash)
  }
  const provider = await getProviderInstance(config, providerId)
  if (typeof provider.getTorrentInfoHash !== "function") {
    throw new Error("provider does not support getTorrentInfoHash")
  }
  const value = await provider.getTorrentInfoHash(torrent)
  return String(value || "")
}

export async function getTorrentProviderSettings(config, providerId) {
  const provider = await getProviderInstance(config, providerId)
  if (typeof provider.getSettings !== "function") {
    return {
      canSmartSearch: Boolean(provider?.settings?.canSmartSearch),
      smartSearchFilters: Array.isArray(provider?.settings?.smartSearchFilters) ? provider.settings.smartSearchFilters : [],
      supportsAdult: Boolean(provider?.settings?.supportsAdult),
      type: String(provider?.settings?.type || "main"),
    }
  }
  const settings = await provider.getSettings()
  return settings && typeof settings === "object" ? settings : {}
}

export function normalizeTorrentProviderMedia(input) {
  const base = input && typeof input === "object" ? input : {}
  const title = base.title && typeof base.title === "object" ? base.title : {}
  const synonyms = Array.isArray(base.synonyms) ? base.synonyms.map(String) : []

  const englishTitle = title.english ? String(title.english) : ""
  return {
    id: Number(base.id || 0) || 0,
    idMal: Number(base.idMal || 0) || undefined,
    status: String(base.status || "NOT_YET_RELEASED") || "NOT_YET_RELEASED",
    format: String(base.format || "TV") || "TV",
    englishTitle: englishTitle ? englishTitle : undefined,
    romajiTitle: String(title.romaji || base.romajiTitle || base.titleRomaji || ""),
    episodeCount: typeof base.episodes === "number" ? base.episodes : (Number(base.totalEpisodes || 0) || -1),
    absoluteSeasonOffset: Number(base.absoluteSeasonOffset || 0) || 0,
    synonyms,
    isAdult: Boolean(base.isAdult),
    startDate: base.startDate && typeof base.startDate === "object"
      ? normalizeFuzzyDate(base.startDate)
      : undefined,
  }
}

function normalizeFuzzyDate(input) {
  const value = input && typeof input === "object" ? input : {}
  const year = Number(value.year || 0) || 0
  if (!year) return undefined
  const month = Number(value.month || 0) || undefined
  const day = Number(value.day || 0) || undefined
  return { year, month, day }
}

function normalizeAnimeTorrent(input, providerId) {
  const torrent = input && typeof input === "object" ? input : {}
  return {
    provider: String(torrent.provider || providerId || ""),
    name: String(torrent.name || torrent.title || ""),
    date: String(torrent.date || ""),
    size: Number(torrent.size || 0) || 0,
    formattedSize: String(torrent.formattedSize || ""),
    seeders: Number(torrent.seeders || 0) || 0,
    leechers: Number(torrent.leechers || 0) || 0,
    downloadCount: Number(torrent.downloadCount || 0) || 0,
    link: String(torrent.link || ""),
    downloadUrl: String(torrent.downloadUrl || torrent.downloadURL || ""),
    magnetLink: torrent.magnetLink ? String(torrent.magnetLink) : "",
    infoHash: torrent.infoHash ? String(torrent.infoHash) : "",
    resolution: String(torrent.resolution || ""),
    isBatch: Boolean(torrent.isBatch),
    episodeNumber: typeof torrent.episodeNumber === "number" ? torrent.episodeNumber : Number(torrent.episodeNumber || 0) || 0,
    releaseGroup: String(torrent.releaseGroup || ""),
    isBestRelease: Boolean(torrent.isBestRelease),
    confirmed: Boolean(torrent.confirmed),
  }
}

async function getProviderInstance(config, providerId) {
  const cacheKey = `${config.extensionsDir}:${providerId}`
  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)
  }

  const extension = getInstalledExtensionById(config, providerId)
  if (!extension || extension.type !== "anime-torrent-provider") {
    throw new Error("torrent provider not installed")
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
    LoadDoc,
    structuredClone,
  })

  const script = new vm.Script(`${source}\n;globalThis.__NIXER_PROVIDER_CLASS__ = Provider;`, {
    filename: `${providerId}.js`,
  })
  script.runInContext(context, { timeout: 30000 })

  const ProviderCtor = context.__NIXER_PROVIDER_CLASS__
  if (typeof ProviderCtor !== "function") {
    throw new Error("provider class not found")
  }

  const rawProvider = new ProviderCtor()
  const provider = normalizeProviderMethods(rawProvider)

  if (typeof provider.search !== "function") {
    throw new Error("provider search method missing")
  }

  provider.__nixerProviderId = providerId
  providerCache.set(cacheKey, provider)
  return provider
}

function normalizeProviderMethods(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("provider instance invalid")
  }

  const mapped = provider

  mapped.search = mapped.search || mapped.Search
  mapped.smartSearch = mapped.smartSearch || mapped.SmartSearch
  mapped.getTorrentInfoHash = mapped.getTorrentInfoHash || mapped.GetTorrentInfoHash
  mapped.getTorrentMagnetLink = mapped.getTorrentMagnetLink || mapped.GetTorrentMagnetLink
  mapped.getLatest = mapped.getLatest || mapped.GetLatest
  mapped.getSettings = mapped.getSettings || mapped.GetSettings

  return mapped
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
  code = code.replace(/^(\s*async\s+[A-Za-z_$][\w$]*)\(([^)]*)\)\s*:\s*[^({=\n]+(?:<[^>\n]+>)?\s*\{/gm, (_m, prefix, params) => {
    return `${prefix}(${stripTypedParameters(params)}) {`
  })
  code = code.replace(/^(\s*[A-Za-z_$][\w$]*)\(([^)]*)\)\s*:\s*[^({=\n]+(?:<[^>\n]+>)?\s*\{/gm, (_m, prefix, params) => {
    return `${prefix}(${stripTypedParameters(params)}) {`
  })
  code = code.replace(/\(([^)]*)\)\s*:\s*[^=({\n]+(?:<[^>\n]+>)?\s*=>/g, (_m, params) => {
    return `(${stripTypedParameters(params)}) =>`
  })
  code = code.replace(/<[^>\n]+>\s*(?=\()/g, "")
  return code
}

function stripTypedParameters(input) {
  return String(input || "")
    .split(",")
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return ""
      const [head] = trimmed.split(":")
      return head.trim()
    })
    .filter(Boolean)
    .join(", ")
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
      minify: false,
    })
    return result?.code || null
  } catch {
    return null
  }
}

function getEsbuildTransformSync() {
  if (esbuildTransformSync) return esbuildTransformSync
  try {
    const esbuild = require("esbuild")
    esbuildTransformSync = esbuild.transformSync
  } catch {
    esbuildTransformSync = null
  }
  return esbuildTransformSync
}

function createLoadDoc() {
  let cheerio = null

  return function LoadDoc(html) {
    if (!cheerio) {
      cheerio = require("cheerio")
    }

    const $ = cheerio.load(String(html || ""))

    function wrap(selection) {
      const api = {
        find(selector) {
          return wrap(selection.find(String(selector || "")))
        },
        children(selector) {
          return selector === undefined
            ? wrap(selection.children())
            : wrap(selection.children(String(selector || "")))
        },
        has(selector) {
          return wrap(selection.has(String(selector || "")))
        },
        first() {
          return wrap(selection.first())
        },
        text() {
          return selection.text()
        },
        html() {
          return selection.html() || ""
        },
        attrs() {
          const first = selection?.[0]
          return first?.attribs && typeof first.attribs === "object" ? first.attribs : {}
        },
        each(callback) {
          selection.each((index, element) => {
            callback(index, wrap($(element)))
          })
        },
        map(callback) {
          const out = []
          selection.each((index, element) => {
            out.push(callback(index, wrap($(element))))
          })
          return out
        },
      }

      Object.defineProperty(api, "length", {
        enumerable: true,
        get() {
          return selection.length
        },
      })

      return api
    }

    return function select(selector) {
      return wrap($(String(selector || "")))
    }
  }
}


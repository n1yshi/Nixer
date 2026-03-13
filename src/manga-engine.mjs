import vm from "node:vm"
import { createRequire } from "node:module"

import { getExtensionUserConfig, getInstalledExtensionById } from "./extensions-repo.mjs"

const providerCache = new Map()
let esbuildTransformSync = null
const require = createRequire(import.meta.url)
const LoadDoc = createLoadDoc()

export async function searchManga(config, providerId, query) {
  const normalizedQuery = String(query || "").trim().toLowerCase()
  if (!normalizedQuery) return []

  const provider = await getProviderInstance(config, providerId)
  const raw = await provider.search({ query: normalizedQuery, year: 0 })
  const list = Array.isArray(raw) ? raw : []
  return list.map((item) => ({
    ...item,
    provider: providerId,
    id: String(item?.id || ""),
    title: String(item?.title || ""),
    synonyms: Array.isArray(item?.synonyms) ? item.synonyms.map(String) : [],
    year: Number(item?.year || 0) || 0,
    image: String(item?.image || ""),
    searchRating: typeof item?.searchRating === "number" ? item.searchRating : undefined,
  })).filter((item) => item.id && item.title)
}

export async function findMangaChapters(config, providerId, mangaId) {
  const provider = await getProviderInstance(config, providerId)
  const raw = await provider.findChapters(String(mangaId || ""))
  const list = Array.isArray(raw) ? raw : []
  return list.map((chapter, index) => ({
    provider: providerId,
    id: String(chapter?.id || ""),
    url: String(chapter?.url || ""),
    title: String(chapter?.title || ""),
    chapter: String(chapter?.chapter || ""),
    index: Number(chapter?.index ?? index) || 0,
    scanlator: chapter?.scanlator ? String(chapter.scanlator) : "",
    language: chapter?.language ? String(chapter.language) : "",
    rating: Number(chapter?.rating || 0) || 0,
    updatedAt: chapter?.updatedAt ? String(chapter.updatedAt) : "",
    localIsPDF: Boolean(chapter?.localIsPDF),
  })).filter((chapter) => chapter.id)
}

export async function findMangaChapterPages(config, providerId, chapterId) {
  const provider = await getProviderInstance(config, providerId)
  const raw = await provider.findChapterPages(String(chapterId || ""))
  const list = Array.isArray(raw) ? raw : []
  return list.map((page, index) => ({
    provider: providerId,
    url: String(page?.url || ""),
    index: Number(page?.index ?? index) || 0,
    headers: page?.headers && typeof page.headers === "object" && !Array.isArray(page.headers)
      ? page.headers
      : {}
  })).filter((page) => page.url)
}

async function getProviderInstance(config, providerId) {
  const cacheKey = `${config.extensionsDir}:${providerId}`
  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)
  }

  const extension = getInstalledExtensionById(config, providerId)
  if (!extension || extension.type !== "manga-provider") {
    throw new Error("manga provider not installed")
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
  if (typeof provider.search !== "function" || typeof provider.findChapters !== "function" || typeof provider.findChapterPages !== "function") {
    throw new Error("provider methods missing (search/findChapters/findChapterPages)")
  }

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
      minify: false
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
        }
      }

      Object.defineProperty(api, "length", {
        enumerable: true,
        get() {
          return selection.length
        }
      })

      return api
    }

    return function select(selector) {
      return wrap($(String(selector || "")))
    }
  }
}

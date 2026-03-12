import fs from "node:fs"
import path from "node:path"

const DEFAULT_MARKETPLACE_URL = "https://raw.githubusercontent.com/5rahim/seanime-extensions/refs/heads/main/marketplace.json"

export function createExtensionRepository(config) {
  fs.mkdirSync(config.extensionDir, { recursive: true })
  fs.mkdirSync(path.dirname(config.pluginSettingsPath), { recursive: true })
  fs.mkdirSync(path.dirname(config.extensionUserConfigPath), { recursive: true })

  return {
    fetchExternalExtensionData: (manifestUri) => fetchExternalExtensionData(manifestUri),
    installExternalExtension: async (manifestUri) => {
      const ext = await fetchExternalExtensionData(manifestUri)
      writeInstalledExtension(config, ext)
      return { message: `Successfully installed ${ext.name}` }
    },
    installExternalExtensions: async (repositoryUri, install) => {
      const manifestUris = await fetchRepositoryManifestUris(repositoryUri)
      const extensions = await Promise.all(manifestUris.map((manifestUri) => fetchExternalExtensionData(manifestUri)))
      if (install) {
        for (const ext of extensions) {
          writeInstalledExtension(config, ext)
        }
      }
      return {
        extensions,
        message: install
          ? `Successfully installed ${extensions.length} extensions`
          : `Fetched ${extensions.length} extensions`
      }
    },
    uninstallExternalExtension: (id) => uninstallExternalExtension(config, id),
    listExtensionData: () => listInstalledExtensions(config),
    listDevelopmentModeExtensions: () => listInstalledExtensions(config).filter((ext) => ext.isDevelopment),
    getAllExtensions: (withUpdates = false) => ({
      extensions: listInstalledExtensions(config),
      invalidExtensions: [],
      invalidUserConfigExtensions: [],
      hasUpdate: [],
      unsafeExtensions: {}
    }),
    listMangaProviderExtensions: () => listInstalledExtensions(config)
      .filter((ext) => ext.type === "manga-provider")
      .map(toMangaProviderItem),
    listOnlinestreamProviderExtensions: () => listInstalledExtensions(config)
      .filter((ext) => ext.type === "onlinestream-provider")
      .map(toOnlinestreamProviderItem),
    listAnimeTorrentProviderExtensions: () => listInstalledExtensions(config)
      .filter((ext) => ext.type === "anime-torrent-provider")
      .map(toAnimeTorrentProviderItem),
    listCustomSourceExtensions: () => listInstalledExtensions(config)
      .filter((ext) => ext.type === "custom-source")
      .map(toCustomSourceProviderItem),
    getExtensionPayload: (id) => {
      const ext = getInstalledExtension(config, id)
      return ext?.payload || ""
    },
    getMarketplaceExtensions: (marketplaceUrl = "") => getMarketplaceExtensions(marketplaceUrl),
    getPluginSettings: () => readJson(config.pluginSettingsPath, {
      pinnedTrayPluginIds: [],
      pluginGrantedPermissions: {}
    }),
    setPluginSettingsPinnedTrays: (pinnedTrayPluginIds) => {
      const current = readJson(config.pluginSettingsPath, {
        pinnedTrayPluginIds: [],
        pluginGrantedPermissions: {}
      })
      const next = {
        ...current,
        pinnedTrayPluginIds: Array.isArray(pinnedTrayPluginIds) ? pinnedTrayPluginIds : []
      }
      writeJson(config.pluginSettingsPath, next)
      return next
    },
    getExtensionUserConfig: (id) => {
      const allConfigs = readJson(config.extensionUserConfigPath, {})
      const extension = getInstalledExtension(config, id)
      return {
        userConfig: extension?.userConfig,
        savedUserConfig: allConfigs[id]
      }
    },
    saveExtensionUserConfig: ({ id, version, values }) => {
      const allConfigs = readJson(config.extensionUserConfigPath, {})
      allConfigs[id] = {
        version,
        values: values || {}
      }
      writeJson(config.extensionUserConfigPath, allConfigs)
      return true
    }
  }
}

async function fetchExternalExtensionData(manifestUri) {
  const ext = await fetchJson(manifestUri)
  if (!ext?.id || !ext?.manifestURI) {
    throw new Error("invalid extension manifest")
  }

  if (ext.payloadURI && !ext.payload) {
    const payloadResponse = await fetch(ext.payloadURI)
    if (!payloadResponse.ok) {
      throw new Error(`failed to fetch extension payload: ${payloadResponse.status}`)
    }
    ext.payload = await payloadResponse.text()
  }

  return normalizeExtension(ext, manifestUri)
}

async function fetchRepositoryManifestUris(repositoryUri) {
  if (String(repositoryUri || "").trim().startsWith("{")) {
    const parsed = JSON.parse(repositoryUri)
    return Array.isArray(parsed?.urls) ? parsed.urls.filter(Boolean) : []
  }

  const parsed = await fetchJson(repositoryUri)
  return Array.isArray(parsed?.urls) ? parsed.urls.filter(Boolean) : []
}

async function getMarketplaceExtensions(marketplaceUrl = "") {
  const url = marketplaceUrl || DEFAULT_MARKETPLACE_URL
  const extensions = await fetchJson(url)
  if (!Array.isArray(extensions)) {
    throw new Error("invalid marketplace payload")
  }
  return extensions
    .filter((ext) => ext?.id && ext?.manifestURI)
    .map((ext) => normalizeExtension(ext, ext.manifestURI))
}

function listInstalledExtensions(config) {
  const filenames = fs.readdirSync(config.extensionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(config.extensionDir, entry.name))

  return filenames
    .map((filename) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(filename, "utf8"))
        return normalizeExtension(parsed, parsed.manifestURI || "file")
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function getInstalledExtension(config, id) {
  return listInstalledExtensions(config).find((ext) => ext.id === id) || null
}

function writeInstalledExtension(config, ext) {
  writeJson(path.join(config.extensionDir, `${ext.id}.json`), ext)
}

function uninstallExternalExtension(config, id) {
  const filename = path.join(config.extensionDir, `${id}.json`)
  if (fs.existsSync(filename)) {
    fs.unlinkSync(filename)
  }
  return true
}

function normalizeExtension(ext, manifestUri) {
  return {
    id: String(ext.id),
    name: String(ext.name || ext.id),
    version: String(ext.version || "0.0.0"),
    semverConstraint: ext.semverConstraint || "",
    manifestURI: String(ext.manifestURI || manifestUri || ""),
    language: ext.language || "javascript",
    type: ext.type || "plugin",
    description: ext.description || "",
    author: ext.author || "",
    icon: ext.icon || "",
    website: ext.website || "",
    readme: ext.readme || "",
    notes: ext.notes || "",
    lang: ext.lang || "en",
    permissions: Array.isArray(ext.permissions) ? ext.permissions : [],
    userConfig: ext.userConfig,
    payload: ext.payload || "",
    payloadURI: ext.payloadURI || "",
    plugin: ext.plugin,
    isDevelopment: Boolean(ext.isDevelopment)
  }
}

function toOnlinestreamProviderItem(ext) {
  return {
    id: ext.id,
    name: ext.name,
    lang: ext.lang || "en",
    episodeServers: ext?.payloadConfig?.episodeServers || ext?.plugin?.episodeServers || ext?.settings?.episodeServers || [],
    supportsDub: Boolean(ext?.payloadConfig?.supportsDub ?? ext?.plugin?.supportsDub ?? ext?.settings?.supportsDub)
  }
}

function toMangaProviderItem(ext) {
  return {
    id: ext.id,
    name: ext.name,
    lang: ext.lang || "en",
    settings: ext.settings || {}
  }
}

function toAnimeTorrentProviderItem(ext) {
  return {
    id: ext.id,
    name: ext.name,
    lang: ext.lang || "en",
    settings: ext.settings || {}
  }
}

function toCustomSourceProviderItem(ext) {
  return {
    id: ext.id,
    extensionIdentifier: Number(ext.extensionIdentifier || 0),
    name: ext.name,
    lang: ext.lang || "en",
    settings: ext.settings || {}
  }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status}`)
  }
  return response.json()
}

function readJson(filename, fallback) {
  try {
    if (!fs.existsSync(filename)) return fallback
    return JSON.parse(fs.readFileSync(filename, "utf8"))
  } catch {
    return fallback
  }
}

function writeJson(filename, payload) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, JSON.stringify(payload, null, 2))
}

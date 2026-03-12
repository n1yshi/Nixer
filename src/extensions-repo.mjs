import fs from "node:fs"
import path from "node:path"

const DEFAULT_MARKETPLACE_URL = "https://raw.githubusercontent.com/5rahim/seanime-extensions/refs/heads/main/marketplace.json"

const EMPTY_PLUGIN_SETTINGS = {
  pinnedTrayPluginIds: [],
  pluginGrantedPermissions: {}
}

function ensureRepoDirs(config) {
  fs.mkdirSync(config.extensionsDir, { recursive: true })
  fs.mkdirSync(config.extensionUserConfigDir, { recursive: true })
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeExtension(raw, manifestUri = "") {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid extension manifest")
  }

  return {
    id: String(raw.id || "").trim(),
    name: String(raw.name || "").trim(),
    version: String(raw.version || "").trim(),
    semverConstraint: String(raw.semverConstraint || "").trim(),
    manifestURI: String(raw.manifestURI || manifestUri || "").trim(),
    language: String(raw.language || "javascript").trim(),
    type: String(raw.type || "").trim(),
    description: String(raw.description || "").trim(),
    author: String(raw.author || "").trim(),
    icon: String(raw.icon || "").trim(),
    website: String(raw.website || "").trim(),
    readme: String(raw.readme || "").trim(),
    notes: String(raw.notes || "").trim(),
    lang: String(raw.lang || "en").trim() || "en",
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    userConfig: raw.userConfig && typeof raw.userConfig === "object" ? raw.userConfig : undefined,
    payload: String(raw.payload || ""),
    payloadURI: String(raw.payloadURI || "").trim(),
    plugin: raw.plugin && typeof raw.plugin === "object" ? raw.plugin : undefined,
    isDevelopment: Boolean(raw.isDevelopment)
  }
}

function validateExtension(ext) {
  if (!ext.id) throw new Error("extension id is required")
  if (!ext.name) throw new Error("extension name is required")
  if (!ext.version) throw new Error("extension version is required")
  if (!ext.type) throw new Error("extension type is required")
  if (!ext.manifestURI) throw new Error("extension manifestURI is required")
  if (!ext.payload && !ext.payloadURI) throw new Error("extension payload or payloadURI is required")
}

function extensionFilePath(config, id) {
  return path.join(config.extensionsDir, `${id}.json`)
}

function extensionUserConfigPath(config, id) {
  return path.join(config.extensionUserConfigDir, `${id}.json`)
}

function readInstalledExtensionFiles(config) {
  ensureRepoDirs(config)
  return fs.readdirSync(config.extensionsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(config.extensionsDir, name))
}

function readStoredExtension(filepath) {
  const raw = fs.readFileSync(filepath, "utf8")
  return normalizeExtension(safeJsonParse(raw, {}))
}

function loadInstalledExtensions(config) {
  const extensions = []
  const invalidExtensions = []

  for (const filepath of readInstalledExtensionFiles(config)) {
    try {
      const extension = readStoredExtension(filepath)
      validateExtension(extension)
      extensions.push(extension)
    } catch (error) {
      const raw = safeJsonParse(fs.readFileSync(filepath, "utf8"), {})
      invalidExtensions.push({
        id: String(raw.id || path.basename(filepath, ".json")),
        path: filepath,
        extension: normalizeExtension(raw),
        reason: error?.message || "invalid extension",
        code: "invalid_manifest"
      })
    }
  }

  return { extensions, invalidExtensions }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  })

  if (!response.ok) {
    throw new Error(`request failed with ${response.status}`)
  }

  return response.json()
}

async function fetchText(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`request failed with ${response.status}`)
  }

  return response.text()
}

async function fetchExtensionManifest(manifestUri, { skipPayload = false } = {}) {
  const manifest = await fetchJson(manifestUri)
  const extension = normalizeExtension(manifest, manifestUri)

  if (!skipPayload && extension.payloadURI && !extension.payload) {
    extension.payload = await fetchText(extension.payloadURI)
  }

  validateExtension(extension)
  return extension
}

function getProviderSettings(extension) {
  return extension.plugin?.settings || extension.settings || {}
}

function getOnlinestreamProviderItem(extension) {
  const settings = getProviderSettings(extension)
  return {
    id: extension.id,
    name: extension.name,
    lang: extension.lang || "en",
    episodeServers: Array.isArray(settings.episodeServers) ? settings.episodeServers : [],
    supportsDub: Boolean(settings.supportsDub)
  }
}

function getMangaProviderItem(extension) {
  return {
    id: extension.id,
    name: extension.name,
    lang: extension.lang || "en",
    settings: getProviderSettings(extension)
  }
}

function getAnimeTorrentProviderItem(extension) {
  return {
    id: extension.id,
    name: extension.name,
    lang: extension.lang || "en",
    settings: getProviderSettings(extension)
  }
}

function getCustomSourceItem(extension) {
  const settings = getProviderSettings(extension)
  return {
    id: extension.id,
    extensionIdentifier: Number(settings.extensionIdentifier || 0),
    name: extension.name,
    lang: extension.lang || "en",
    settings
  }
}

export async function getMarketplaceExtensions(config, marketplaceUrl) {
  const targetUrl = String(marketplaceUrl || DEFAULT_MARKETPLACE_URL).trim() || DEFAULT_MARKETPLACE_URL
  const raw = await fetchJson(targetUrl)
  if (!Array.isArray(raw)) {
    throw new Error("marketplace response must be an array")
  }

  return raw
    .map((item) => normalizeExtension(item, item?.manifestURI || item?.manifestUri || ""))
    .filter((item) => item.id && item.manifestURI)
}

export async function fetchExternalExtensionData(manifestUri) {
  return fetchExtensionManifest(String(manifestUri || "").trim())
}

export async function installExternalExtension(config, manifestUri) {
  ensureRepoDirs(config)
  const extension = await fetchExtensionManifest(String(manifestUri || "").trim())
  const filePath = extensionFilePath(config, extension.id)
  const exists = fs.existsSync(filePath)
  fs.writeFileSync(filePath, JSON.stringify(extension, null, 2))

  return {
    extension,
    response: {
      message: `${exists ? "Successfully updated" : "Successfully installed"} ${extension.name}`
    }
  }
}

export async function installExternalExtensionRepository(config, repositoryUri, install) {
  const value = String(repositoryUri || "").trim()
  if (!value) {
    throw new Error("repositoryUri is required")
  }

  let repo
  if (value.startsWith("{")) {
    repo = safeJsonParse(value, {})
  } else {
    repo = await fetchJson(value)
  }

  const urls = Array.isArray(repo?.urls) ? repo.urls : []
  const extensions = []

  for (const manifestUri of urls) {
    try {
      const ext = await fetchExtensionManifest(manifestUri, { skipPayload: !install })
      if (ext.type === "plugin") continue
      extensions.push(ext)
      if (install) {
        fs.writeFileSync(extensionFilePath(config, ext.id), JSON.stringify(ext, null, 2))
      }
    } catch {
    }
  }

  return {
    extensions,
    message: install ? `Installed ${extensions.length} extension(s)` : `Found ${extensions.length} extension(s)`
  }
}

export function uninstallExternalExtension(config, id) {
  const filePath = extensionFilePath(config, id)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }

  const userConfigPath = extensionUserConfigPath(config, id)
  if (fs.existsSync(userConfigPath)) {
    fs.unlinkSync(userConfigPath)
  }

  const pluginSettings = getPluginSettings(config)
  pluginSettings.pinnedTrayPluginIds = (pluginSettings.pinnedTrayPluginIds || []).filter((item) => item !== id)
  if (pluginSettings.pluginGrantedPermissions) {
    delete pluginSettings.pluginGrantedPermissions[id]
  }
  savePluginSettings(config, pluginSettings)
}

export function listExtensionData(config) {
  return loadInstalledExtensions(config).extensions.map((extension) => ({
    ...extension,
    payload: ""
  }))
}

export function getInstalledExtensionById(config, id) {
  const filePath = extensionFilePath(config, id)
  if (!fs.existsSync(filePath)) return null
  const extension = readStoredExtension(filePath)
  validateExtension(extension)
  return extension
}

export function getAllExtensions(config) {
  const { extensions, invalidExtensions } = loadInstalledExtensions(config)
  return {
    extensions: extensions.map((extension) => ({ ...extension, payload: "" })),
    invalidExtensions,
    invalidUserConfigExtensions: [],
    hasUpdate: [],
    unsafeExtensions: {}
  }
}

export function getExtensionPayload(config, id) {
  const filePath = extensionFilePath(config, id)
  if (!fs.existsSync(filePath)) return ""
  return readStoredExtension(filePath).payload || ""
}

export function updateExtensionCode(config, id, payload) {
  const filePath = extensionFilePath(config, id)
  if (!fs.existsSync(filePath)) {
    throw new Error("extension not found")
  }

  const extension = readStoredExtension(filePath)
  extension.payload = String(payload || "")
  fs.writeFileSync(filePath, JSON.stringify(extension, null, 2))
}

export function listDevelopmentModeExtensions(config) {
  return loadInstalledExtensions(config).extensions
    .filter((extension) => extension.isDevelopment)
    .map((extension) => ({ ...extension, payload: "" }))
}

export function listMangaProviderExtensions(config) {
  return loadInstalledExtensions(config).extensions
    .filter((extension) => extension.type === "manga-provider")
    .map(getMangaProviderItem)
}

export function listOnlinestreamProviderExtensions(config) {
  return loadInstalledExtensions(config).extensions
    .filter((extension) => extension.type === "onlinestream-provider")
    .map(getOnlinestreamProviderItem)
}

export function listAnimeTorrentProviderExtensions(config) {
  return loadInstalledExtensions(config).extensions
    .filter((extension) => extension.type === "anime-torrent-provider")
    .map(getAnimeTorrentProviderItem)
}

export function listCustomSourceExtensions(config) {
  return loadInstalledExtensions(config).extensions
    .filter((extension) => extension.type === "custom-source")
    .map(getCustomSourceItem)
}

export function getPluginSettings(config) {
  ensureRepoDirs(config)
  if (!fs.existsSync(config.pluginSettingsPath)) {
    fs.writeFileSync(config.pluginSettingsPath, JSON.stringify(EMPTY_PLUGIN_SETTINGS, null, 2))
    return structuredClone(EMPTY_PLUGIN_SETTINGS)
  }

  const raw = safeJsonParse(fs.readFileSync(config.pluginSettingsPath, "utf8"), EMPTY_PLUGIN_SETTINGS)
  return {
    pinnedTrayPluginIds: Array.isArray(raw?.pinnedTrayPluginIds) ? raw.pinnedTrayPluginIds : [],
    pluginGrantedPermissions: raw?.pluginGrantedPermissions && typeof raw.pluginGrantedPermissions === "object"
      ? raw.pluginGrantedPermissions
      : {}
  }
}

export function savePluginSettings(config, settings) {
  const payload = {
    pinnedTrayPluginIds: Array.isArray(settings?.pinnedTrayPluginIds) ? settings.pinnedTrayPluginIds : [],
    pluginGrantedPermissions: settings?.pluginGrantedPermissions && typeof settings.pluginGrantedPermissions === "object"
      ? settings.pluginGrantedPermissions
      : {}
  }
  fs.writeFileSync(config.pluginSettingsPath, JSON.stringify(payload, null, 2))
  return payload
}

export function grantPluginPermissions(config, id) {
  const filePath = extensionFilePath(config, id)
  if (!fs.existsSync(filePath)) {
    throw new Error("extension not found")
  }

  const extension = readStoredExtension(filePath)
  const permissions = Array.isArray(extension?.plugin?.permissions) ? extension.plugin.permissions : []
  const hash = permissions.join("|")
  const settings = getPluginSettings(config)
  settings.pluginGrantedPermissions[id] = hash
  savePluginSettings(config, settings)
  return true
}

export function getExtensionUserConfig(config, id) {
  const filePath = extensionFilePath(config, id)
  if (!fs.existsSync(filePath)) {
    return {
      userConfig: undefined,
      savedUserConfig: undefined
    }
  }

  const extension = readStoredExtension(filePath)
  const savedPath = extensionUserConfigPath(config, id)
  const savedUserConfig = fs.existsSync(savedPath)
    ? safeJsonParse(fs.readFileSync(savedPath, "utf8"), undefined)
    : undefined

  return {
    userConfig: extension.userConfig,
    savedUserConfig
  }
}

export function saveExtensionUserConfig(config, id, version, values) {
  ensureRepoDirs(config)
  const payload = {
    version: Number(version || 0),
    values: values && typeof values === "object" ? values : {}
  }
  fs.writeFileSync(extensionUserConfigPath(config, id), JSON.stringify(payload, null, 2))
  return true
}

export {
  DEFAULT_MARKETPLACE_URL
}

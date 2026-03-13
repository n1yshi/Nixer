import fs from "node:fs"
import path from "node:path"

const DEFAULTS = {
  mediastream: {
    transcodeEnabled: false,
    transcodeHwAccel: "",
    transcodeThreads: 0,
    transcodePreset: "",
    disableAutoSwitchToDirectPlay: false,
    directPlayOnly: false,
    preTranscodeEnabled: false,
    preTranscodeLibraryDir: "",
    ffmpegPath: "",
    ffprobePath: "",
    transcodeHwAccelCustomSettings: "",
  },
  torrentstream: {
    enabled: false,
    autoSelect: false,
    preferredResolution: "",
    disableIPV6: false,
    downloadDir: "",
    addToLibrary: false,
    torrentClientHost: "",
    torrentClientPort: 0,
    streamingServerHost: "",
    streamingServerPort: 0,
    includeInLibrary: false,
    streamUrlAddress: "",
    slowSeeding: false,
    preloadNextStream: false,
  },
  debrid: {
    enabled: false,
    provider: "none",
  },
}

export function getMediastreamSettings(config) {
  return loadSettings(config, "mediastream", DEFAULTS.mediastream)
}

export function saveMediastreamSettings(config, patch) {
  return saveSettings(config, "mediastream", DEFAULTS.mediastream, patch)
}

export function getTorrentstreamSettings(config) {
  return loadSettings(config, "torrentstream", DEFAULTS.torrentstream)
}

export function saveTorrentstreamSettings(config, patch) {
  return saveSettings(config, "torrentstream", DEFAULTS.torrentstream, patch)
}

export function getDebridSettings(config) {
  return loadSettings(config, "debrid", DEFAULTS.debrid)
}

export function saveDebridSettings(config, patch) {
  return saveSettings(config, "debrid", DEFAULTS.debrid, patch)
}

function loadSettings(config, key, defaults) {
  const filepath = getSettingsPath(config, key)
  try {
    const raw = fs.readFileSync(filepath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return structuredClone(defaults)
    }
    return { ...structuredClone(defaults), ...parsed }
  } catch {
    return structuredClone(defaults)
  }
}

function saveSettings(config, key, defaults, patch) {
  const current = loadSettings(config, key, defaults)
  const incoming = patch && typeof patch === "object" ? patch : {}
  const next = { ...current, ...incoming }

  const filepath = getSettingsPath(config, key)
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  const tmp = `${filepath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, filepath)
  return next
}

function getSettingsPath(config, key) {
  return path.join(config.dataDir, "secondary-settings", `${key}.json`)
}


import { logWarn } from "./logging.mjs"

export function getQbittorrentConfigFromSettings(settings) {
  const torrent = settings?.torrent && typeof settings.torrent === "object" ? settings.torrent : {}
  const host = String(torrent.qbittorrentHost || "").trim()
  const port = Number(torrent.qbittorrentPort || 0) || 0
  const username = String(torrent.qbittorrentUsername || "")
  const password = String(torrent.qbittorrentPassword || "")
  const category = String(torrent.qbittorrentCategory || "").trim()
  const tags = String(torrent.qbittorrentTags || "").trim()

  if (!host || !port) return null
  return { host, port, username, password, category, tags }
}

export class QbittorrentClient {
  constructor(config) {
    if (!config || typeof config !== "object") {
      throw new Error("qbittorrent config missing")
    }
    this.baseUrl = buildBaseUrl(config.host, config.port)
    this.username = String(config.username || "")
    this.password = String(config.password || "")
    this.cookie = ""
  }

  async listTorrents({ category, sort } = {}) {
    const query = new URLSearchParams()
    if (category) query.set("category", String(category))
    if (sort) query.set("sort", String(sort))
    const res = await this.#requestJson("GET", `/api/v2/torrents/info?${query.toString()}`)
    return Array.isArray(res) ? res : []
  }

  async torrentExists(hash) {
    const normalized = String(hash || "").trim()
    if (!normalized) return false
    const query = new URLSearchParams({ hashes: normalized })
    const list = await this.#requestJson("GET", `/api/v2/torrents/info?${query.toString()}`)
    return Array.isArray(list) && list.length > 0
  }

  async getFiles(hash) {
    const normalized = String(hash || "").trim()
    if (!normalized) throw new Error("hash is required")
    const query = new URLSearchParams({ hash: normalized })
    const res = await this.#requestJson("GET", `/api/v2/torrents/files?${query.toString()}`)
    return Array.isArray(res) ? res : []
  }

  async addMagnets(magnets, destination, { category = "", tags = "", paused = false } = {}) {
    const urls = Array.isArray(magnets) ? magnets.map((v) => String(v || "").trim()).filter(Boolean) : []
    if (!urls.length) throw new Error("magnets are required")

    const form = new URLSearchParams()
    form.set("urls", urls.join("\n"))
    if (destination) form.set("savepath", String(destination))
    if (category) form.set("category", String(category))
    if (tags) form.set("tags", String(tags))
    if (paused) form.set("paused", "true")

    await this.#requestText("POST", "/api/v2/torrents/add", form)
    return true
  }

  async pauseTorrents(hashes) {
    return this.#simpleHashesPost("/api/v2/torrents/pause", hashes)
  }

  async resumeTorrents(hashes) {
    return this.#simpleHashesPost("/api/v2/torrents/resume", hashes)
  }

  async removeTorrents(hashes, { deleteFiles = false } = {}) {
    const ids = Array.isArray(hashes) ? hashes.map((v) => String(v || "").trim()).filter(Boolean) : []
    if (!ids.length) throw new Error("hashes are required")
    const form = new URLSearchParams()
    form.set("hashes", ids.join("|"))
    form.set("deleteFiles", deleteFiles ? "true" : "false")
    await this.#requestText("POST", "/api/v2/torrents/delete", form)
    return true
  }

  async #simpleHashesPost(pathname, hashes) {
    const ids = Array.isArray(hashes) ? hashes.map((v) => String(v || "").trim()).filter(Boolean) : []
    if (!ids.length) throw new Error("hashes are required")
    const form = new URLSearchParams()
    form.set("hashes", ids.join("|"))
    await this.#requestText("POST", pathname, form)
    return true
  }

  async #login() {
    const form = new URLSearchParams()
    form.set("username", this.username)
    form.set("password", this.password)
    const response = await fetch(new URL("/api/v2/auth/login", this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/plain",
      },
      body: form.toString(),
    })

    const setCookie = response.headers.get("set-cookie") || ""
    const cookie = setCookie.split(";")[0].trim()
    if (cookie) {
      this.cookie = cookie
    }

    const text = await response.text()
    if (!response.ok || !String(text || "").toLowerCase().includes("ok")) {
      throw new Error("qbittorrent login failed")
    }
  }

  async #requestJson(method, pathname) {
    const text = await this.#requestText(method, pathname)
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  async #requestText(method, pathname, form) {
    const needsBody = method !== "GET" && method !== "HEAD"
    const url = new URL(pathname, this.baseUrl)
    const headers = {
      "Accept": "application/json",
    }
    if (this.cookie) {
      headers["Cookie"] = this.cookie
    }
    if (needsBody && form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded"
    }

    let response = await fetch(url, {
      method,
      headers,
      body: needsBody && form ? form.toString() : undefined,
    })

    if (response.status === 403 || response.status === 401) {
      await this.#login()
      const retryHeaders = { ...headers }
      if (this.cookie) retryHeaders["Cookie"] = this.cookie
      response = await fetch(url, {
        method,
        headers: retryHeaders,
        body: needsBody && form ? form.toString() : undefined,
      })
    }

    const setCookie = response.headers.get("set-cookie") || ""
    const cookie = setCookie.split(";")[0].trim()
    if (cookie) {
      this.cookie = cookie
    }

    const text = await response.text()
    if (!response.ok) {
      const trimmed = text && text.length > 160 ? `${text.slice(0, 160)}...` : text
      logWarn("qbittorrent", `request ${method} ${url.pathname} -> ${response.status} ${trimmed || ""}`.trim())
      throw new Error(`qbittorrent request failed: ${response.status}`)
    }
    return text
  }
}

function buildBaseUrl(host, port) {
  const raw = String(host || "").trim()
  if (!raw) {
    throw new Error("qbittorrent host is required")
  }

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return new URL(raw.endsWith("/") ? raw : `${raw}/`).toString()
  }

  const normalizedPort = Number(port || 0) || 0
  if (!normalizedPort) {
    throw new Error("qbittorrent port is required")
  }
  return new URL(`http://${raw}:${normalizedPort}/`).toString()
}


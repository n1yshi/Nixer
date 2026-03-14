import fs from "node:fs"
import path from "node:path"

const VIDEO_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v", ".webm",
])

export function resolveLibraryRoots(settings) {
  const library = settings?.library && typeof settings.library === "object" ? settings.library : {}
  const roots = Array.isArray(library.libraryPaths) && library.libraryPaths.length
    ? library.libraryPaths
    : (library.libraryPath ? [library.libraryPath] : [])

  return roots
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .filter((value) => {
      try {
        return fs.statSync(value).isDirectory()
      } catch {
        return false
      }
    })
}

export async function scanVideoFiles(roots, {
  maxFiles = 20000,
  maxDepth = 12,
} = {}) {
  const out = []
  for (const root of roots) {
    await walk(root, 0)
    if (out.length >= maxFiles) break
  }
  return out

  async function walk(dir, depth) {
    if (out.length >= maxFiles) return
    if (depth > maxDepth) return

    let entries = []
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue

      const ext = path.extname(entry.name).toLowerCase()
      if (!VIDEO_EXTENSIONS.has(ext)) continue
      out.push(full)
    }
  }
}

export function buildLibraryExplorerFileTree(roots, localFiles) {
  const localFilesMap = {}
  const rootNode = newDirNode("Library", "library://root")

  const files = Array.isArray(localFiles) ? localFiles : []
  for (const file of files) {
    if (!file || typeof file !== "object") continue
    const fullPath = String(file.path || "").trim()
    if (!fullPath) continue

    const normalizedPath = normalizePath(fullPath)
    localFilesMap[normalizedPath] = file

    const matchingRoot = roots.find((r) => isPathWithin(fullPath, r))
    const rootLabel = matchingRoot || path.parse(fullPath).root || "/"
    const rootChild = ensureChildDir(rootNode, rootLabel, rootLabel)

    const relative = matchingRoot ? path.relative(matchingRoot, fullPath) : fullPath.replace(/^[/\\\\]+/, "")
    const parts = relative.split(path.sep).filter(Boolean)
    if (!parts.length) continue

    let current = rootChild
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      const isLast = index === parts.length - 1

      if (isLast) {
        const node = {
          name: part,
          path: fullPath,
          normalizedPath,
          kind: "file",
          localFile: file,
        }
        current.children.push(node)
      } else {
        const nextPath = path.join(path.isAbsolute(rootLabel) ? rootLabel : "", ...parts.slice(0, index + 1))
        current = ensureChildDir(current, part, nextPath)
      }
    }
  }

  finalizeCounts(rootNode)
  return { root: rootNode, localFiles: localFilesMap }
}

export async function directorySelector(input) {
  const raw = String(input || "")
  const trimmed = raw.trim()
  const fullPath = trimmed ? path.resolve(trimmed) : path.resolve(process.cwd())

  const exists = await pathExists(fullPath)
  const basePath = exists ? fullPath : path.dirname(fullPath)
  const content = await listDirectoryInfos(exists ? fullPath : basePath)

  const prefix = trimmed ? path.basename(fullPath) : ""
  const suggestions = prefix
    ? content.filter((item) => item.folderName.toLowerCase().startsWith(prefix.toLowerCase()))
    : content

  return {
    fullPath,
    exists,
    basePath,
    suggestions: suggestions.slice(0, 50),
    content: content.slice(0, 200),
  }
}

function newDirNode(name, nodePath) {
  return {
    name,
    path: nodePath,
    normalizedPath: normalizePath(nodePath),
    kind: "directory",
    children: [],
    mediaIds: [],
    localFileCount: 0,
    matchedLocalFileCount: 0,
  }
}

function ensureChildDir(parent, name, nodePath) {
  const children = Array.isArray(parent.children) ? parent.children : []
  let existing = children.find((child) => child.kind === "directory" && child.name === name)
  if (existing) return existing

  existing = newDirNode(name, nodePath)
  children.push(existing)
  parent.children = children
  return existing
}

function finalizeCounts(node) {
  if (!node || typeof node !== "object") return { local: 0, matched: 0, mediaIds: new Set() }

  if (node.kind === "file") {
    const mediaId = Number(node.localFile?.mediaId || 0) || 0
    return {
      local: 1,
      matched: mediaId > 0 ? 1 : 0,
      mediaIds: mediaId > 0 ? new Set([mediaId]) : new Set(),
    }
  }

  const children = Array.isArray(node.children) ? node.children : []
  let localCount = 0
  let matchedCount = 0
  const mediaIds = new Set()

  for (const child of children) {
    const result = finalizeCounts(child)
    localCount += result.local
    matchedCount += result.matched
    for (const id of result.mediaIds) mediaIds.add(id)
  }

  node.localFileCount = localCount
  node.matchedLocalFileCount = matchedCount
  node.mediaIds = [...mediaIds]
  return { local: localCount, matched: matchedCount, mediaIds }
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/")
}

function isPathWithin(candidate, root) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (resolvedCandidate === resolvedRoot) return true
  return resolvedCandidate.startsWith(resolvedRoot + path.sep)
}

async function pathExists(target) {
  try {
    await fs.promises.stat(target)
    return true
  } catch {
    return false
  }
}

async function listDirectoryInfos(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        fullPath: path.join(dir, entry.name),
        folderName: entry.name,
      }))
      .sort((a, b) => a.folderName.localeCompare(b.folderName))
  } catch {
    return []
  }
}


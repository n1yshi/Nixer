import fs from "node:fs"
import path from "node:path"

let cachedStructsPath = ""
let cachedStructIndex = null

export function inferDefaultValueFromApiSpec({
  returnSpec,
  tsType,
  goType,
  structsPath = path.resolve(process.cwd(), "example", "codegen", "generated", "public_structs.json"),
  depth = 3,
  log = () => {},
} = {}) {
  const normalizedReturns = String(returnSpec || "").trim()
  const normalizedTs = String(tsType || "").trim()
  const normalizedGo = String(goType || "").trim()

  if (normalizedReturns === "true") return true

  if (normalizedGo === "bool" || normalizedReturns === "bool" || normalizedTs === "boolean") {
    return false
  }

  const shaped = createDefaultFromTypescriptType(normalizedTs, { structsPath, depth, log })
  if (shaped !== undefined) return shaped

  if (normalizedReturns.startsWith("[]")) return []
  if (normalizedTs.startsWith("Array<")) return []
  if (normalizedTs.endsWith("[]")) return []

  if (normalizedTs.startsWith("Record<")) return {}

  if (normalizedGo === "string" || normalizedReturns === "string" || normalizedTs === "string") return ""
  if (normalizedGo === "int" || normalizedGo === "int64" || normalizedGo === "float64" || normalizedTs === "number") return 0

  return {}
}

export function createDefaultFromTypescriptType(tsType, { structsPath, depth = 3, log = () => {} } = {}) {
  const normalized = normalizeTypeString(tsType)
  if (!normalized) return undefined

  if (normalized === "string") return ""
  if (normalized === "number") return 0
  if (normalized === "boolean") return false
  if (normalized === "null") return null
  if (normalized === "undefined" || normalized === "void") return undefined

  const arrayInner = extractArrayInnerType(normalized)
  if (arrayInner) return []

  const record = extractRecordTypes(normalized)
  if (record) return {}

  const map = extractMapTypes(normalized)
  if (map) return {}

  const literal = extractStringLiteral(normalized)
  if (literal !== null) return literal

  const structIndex = getStructIndex(structsPath, log)
  if (!structIndex) return undefined

  return createDefaultFromStructName(normalized, { structIndex, depth })
}

function createDefaultFromStructName(typeName, { structIndex, depth, visited = new Set() } = {}) {
  if (!typeName) return {}
  if (depth <= 0) return {}
  if (visited.has(typeName)) return {}

  const def = structIndex.get(typeName)
  if (!def) return {}

  visited.add(typeName)

  const fields = Array.isArray(def.fields) ? def.fields : []
  const out = {}
  for (const field of fields) {
    if (!field || typeof field !== "object") continue
    if (!field.public) continue

    const jsonName = String(field.jsonName || field.name || "").trim()
    if (!jsonName) continue

    const fieldType = normalizeTypeString(field.usedTypescriptType || field.typescriptType || "")
    const fieldGoType = String(field.goType || "")
    out[jsonName] = createDefaultFromFieldType(fieldType, fieldGoType, { structIndex, depth: depth - 1, visited })
  }

  visited.delete(typeName)
  return out
}

function createDefaultFromFieldType(typeString, goType, { structIndex, depth, visited }) {
  const normalized = normalizeTypeString(typeString)
  if (!normalized) return null

  const normalizedGo = String(goType || "").trim()
  if (normalizedGo.startsWith("[]")) return []
  if (normalizedGo.startsWith("map[")) return {}

  if (normalized === "string") return ""
  if (normalized === "number") return 0
  if (normalized === "boolean") return false
  if (normalized === "null") return null
  if (normalized === "undefined" || normalized === "void") return undefined

  const arrayInner = extractArrayInnerType(normalized)
  if (arrayInner) return []

  const record = extractRecordTypes(normalized)
  if (record) return {}

  const map = extractMapTypes(normalized)
  if (map) return {}

  const literal = extractStringLiteral(normalized)
  if (literal !== null) return literal

  return createDefaultFromStructName(normalized, { structIndex, depth, visited })
}

function getStructIndex(structsPath, log) {
  const resolved = path.resolve(structsPath)

  if (cachedStructIndex && cachedStructsPath === resolved) {
    return cachedStructIndex
  }

  cachedStructsPath = resolved
  cachedStructIndex = null

  try {
    if (!fs.existsSync(resolved)) return null
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"))
    if (!Array.isArray(parsed)) return null

    const index = new Map()
    for (const def of parsed) {
      if (!def || typeof def !== "object") continue
      const formattedName = String(def.formattedName || "").trim()
      const name = String(def.name || "").trim()
      if (formattedName) index.set(formattedName, def)
      if (name && !index.has(name)) index.set(name, def)
    }

    cachedStructIndex = index
    return cachedStructIndex
  } catch (error) {
    log(`failed to load public structs: ${error?.message || error}`)
    return null
  }
}

function normalizeTypeString(input) {
  let value = String(input || "").trim()
  if (!value) return ""

  // unwrap Promise<T>, Partial<T>, Readonly<T>
  value = unwrapGeneric(value, "Promise")
  value = unwrapGeneric(value, "Partial")
  value = unwrapGeneric(value, "Readonly")

  // strip surrounding parentheses
  value = stripOuterParens(value)

  // choose a non-nullish union member if possible
  value = chooseNonNullishUnionMember(value)

  // intersections: pick the first type
  const intersectionParts = splitTopLevel(value, "&")
  if (intersectionParts.length > 1) {
    value = intersectionParts[0].trim()
  }

  return value.trim()
}

function unwrapGeneric(value, name) {
  const trimmed = String(value || "").trim()
  const prefix = `${name}<`
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(">")) return trimmed
  return trimmed.slice(prefix.length, -1).trim()
}

function stripOuterParens(value) {
  let out = String(value || "").trim()
  while (out.startsWith("(") && out.endsWith(")")) {
    const inner = out.slice(1, -1).trim()
    if (!inner) break
    out = inner
  }
  return out
}

function chooseNonNullishUnionMember(typeString) {
  const parts = splitTopLevel(typeString, "|").map((part) => part.trim()).filter(Boolean)
  if (parts.length <= 1) return typeString

  const filtered = parts.filter((part) => !["null", "undefined", "void"].includes(part))
  return filtered[0] || parts[0] || typeString
}

function extractArrayInnerType(typeString) {
  if (typeString.endsWith("[]")) {
    const inner = typeString.slice(0, -2).trim()
    return inner || "unknown"
  }
  const match = typeString.match(/^Array<(.+)>$/)
  if (match) return match[1].trim() || "unknown"
  return null
}

function extractRecordTypes(typeString) {
  const match = typeString.match(/^Record<(.+)>$/)
  if (!match) return null
  const parts = splitTopLevel(match[1], ",").map((p) => p.trim())
  if (parts.length < 2) return null
  return { key: parts[0], value: parts.slice(1).join(",").trim() }
}

function extractMapTypes(typeString) {
  const match = typeString.match(/^Map<(.+)>$/)
  if (!match) return null
  const parts = splitTopLevel(match[1], ",").map((p) => p.trim())
  if (parts.length < 2) return null
  return { key: parts[0], value: parts.slice(1).join(",").trim() }
}

function extractStringLiteral(typeString) {
  const trimmed = String(typeString || "").trim()
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return null
}

function splitTopLevel(input, separator) {
  const text = String(input || "")
  const sep = String(separator || "")
  if (!text || !sep) return [text]

  const parts = []
  let startIndex = 0

  let angleDepth = 0
  let parenDepth = 0
  let bracketDepth = 0

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === "<") angleDepth += 1
    else if (char === ">") angleDepth = Math.max(0, angleDepth - 1)
    else if (char === "(") parenDepth += 1
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1)
    else if (char === "[") bracketDepth += 1
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1)

    const isTopLevel = angleDepth === 0 && parenDepth === 0 && bracketDepth === 0
    if (!isTopLevel) continue

    if (sep.length === 1) {
      if (char !== sep) continue
      parts.push(text.slice(startIndex, index))
      startIndex = index + 1
      continue
    }

    if (text.startsWith(sep, index)) {
      parts.push(text.slice(startIndex, index))
      startIndex = index + sep.length
      index += sep.length - 1
    }
  }

  parts.push(text.slice(startIndex))
  return parts
}

import fs from "node:fs"
import path from "node:path"

import { inferDefaultValueFromApiSpec } from "./api-type-defaults.mjs"

export function registerGeneratedApiStubs(app, {
  specPath = path.resolve(process.cwd(), "example", "codegen", "generated", "handlers.json"),
  structsPath = path.resolve(process.cwd(), "example", "codegen", "generated", "public_structs.json"),
  enabled = true,
  log = () => {},
  allowOverrideExisting = false,
} = {}) {
  if (!enabled) return { registered: 0, specPath }
  if (!fs.existsSync(specPath)) return { registered: 0, specPath }

  let entries
  try {
    entries = JSON.parse(fs.readFileSync(specPath, "utf8"))
  } catch (error) {
    log(`failed to load handlers spec: ${error?.message || error}`)
    return { registered: 0, specPath }
  }

  if (!Array.isArray(entries)) return { registered: 0, specPath }

  let registered = 0

  for (const entry of entries) {
    const rawEndpoint = entry?.api?.endpoint
    const methods = entry?.api?.methods
    if (typeof rawEndpoint !== "string" || !rawEndpoint.startsWith("/api/")) continue
    if (!Array.isArray(methods) || !methods.length) continue
    const endpoint = normalizeEndpointForExpress(rawEndpoint)

    for (const method of methods) {
      const lower = String(method || "").toLowerCase()
      const handler = buildStubHandler(entry, { structsPath, log })

      if (lower === "head") {
        app.head(endpoint, (_req, res) => {
          res.status(200).end()
        })
        registered += 1
        continue
      }

      if (typeof app[lower] !== "function") continue

      if (!allowOverrideExisting && hasExistingRoute(app, lower, endpoint)) {
        continue
      }

      app[lower](endpoint, handler)
      registered += 1
    }
  }

  return { registered, specPath }
}

function buildStubHandler(entry, { structsPath, log }) {
  const returnSpec = String(entry?.api?.returns || "")
  const tsType = String(entry?.api?.returnTypescriptType || "")
  const goType = String(entry?.api?.returnGoType || "")

  const normalizedReturns = returnSpec.trim()
  const normalizedTs = tsType.trim()
  const normalizedGo = goType.trim()
  const isBooleanReturn = normalizedReturns === "bool" || normalizedGo === "bool" || normalizedTs === "boolean"

  const baseDefaultValue = inferDefaultValueFromApiSpec({
    returnSpec,
    tsType,
    goType,
    structsPath,
    log,
  })

  return (req, res) => {
    if (req.method === "HEAD") {
      res.status(200).end()
      return
    }

    let value = baseDefaultValue && typeof baseDefaultValue === "object"
      ? structuredClone(baseDefaultValue)
      : baseDefaultValue

    if (isBooleanReturn && req.method !== "GET") {
      value = true
    }
    res.json({ data: value })
  }
}

function hasExistingRoute(app, method, endpoint) {
  const router = app?._router
  if (!router || !Array.isArray(router.stack)) return false

  for (const layer of router.stack) {
    const route = layer?.route
    if (!route) continue
    if (route.path !== endpoint) continue
    if (route.methods && route.methods[method]) return true
  }

  return false
}

function normalizeEndpointForExpress(endpoint) {
  return String(endpoint || "").replace(/\{([^}]+)\}/g, (_match, name) => `:${String(name || "").trim()}`)
}

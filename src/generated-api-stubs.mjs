import fs from "node:fs"
import path from "node:path"

export function registerGeneratedApiStubs(app, {
  specPath = path.resolve(process.cwd(), "example", "codegen", "generated", "handlers.json"),
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
    const endpoint = entry?.api?.endpoint
    const methods = entry?.api?.methods
    if (typeof endpoint !== "string" || !endpoint.startsWith("/api/")) continue
    if (!Array.isArray(methods) || !methods.length) continue

    for (const method of methods) {
      const lower = String(method || "").toLowerCase()
      const handler = buildStubHandler(entry)

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

function buildStubHandler(entry) {
  const returnSpec = String(entry?.api?.returns || "")
  const tsType = String(entry?.api?.returnTypescriptType || "")
  const goType = String(entry?.api?.returnGoType || "")

  const defaultValue = inferDefaultValue({ returnSpec, tsType, goType })

  return (req, res) => {
    if (req.method === "HEAD") {
      res.status(200).end()
      return
    }

    res.json({ data: defaultValue })
  }
}

function inferDefaultValue({ returnSpec, tsType, goType }) {
  const normalizedReturns = String(returnSpec || "").trim()
  const normalizedTs = String(tsType || "").trim()
  const normalizedGo = String(goType || "").trim()

  if (normalizedReturns === "true") return true
  if (normalizedGo === "bool" || normalizedReturns === "bool") return true

  if (normalizedReturns.startsWith("[]")) return []
  if (normalizedTs.startsWith("Array<")) return []
  if (normalizedTs.endsWith("[]")) return []

  if (normalizedTs.startsWith("Record<")) return {}

  if (normalizedGo === "string" || normalizedReturns === "string") return ""

  return {}
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

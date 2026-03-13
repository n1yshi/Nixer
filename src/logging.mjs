import { inspect } from "node:util"

import { appendLogLine } from "./logs-store.mjs"

const COLOR_RESET = "\x1b[0m"
const COLOR_BOLD = 1
const COLOR_RED = 31
const COLOR_YELLOW = 33
const COLOR_CYAN = 36
const COLOR_DARK_GRAY = 90

const USE_COLOR = Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR

const LEVEL_STYLES = {
  trace: { label: "TRC", codes: [COLOR_DARK_GRAY] },
  debug: { label: "DBG", codes: [] },
  info: { label: "INF", codes: [COLOR_BOLD] },
  warn: { label: "WRN", codes: [COLOR_YELLOW] },
  error: { label: "ERR", codes: [COLOR_RED] },
}

export function logTrace(scope, message, detail) {
  writeLog("trace", scope, message, detail)
}

export function logDebug(scope, message, detail) {
  writeLog("debug", scope, message, detail)
}

export function logInfo(scope, message, detail) {
  writeLog("info", scope, message, detail)
}

export function logWarn(scope, message, detail) {
  writeLog("warn", scope, message, detail)
}

export function logError(scope, message, detail) {
  writeLog("error", scope, message, detail)
}

function writeLog(level, scope, message, detail) {
  const method = level === "error" ? "error" : "log"
  const headline = formatLogLine(level, scope, message)
  console[method](headline)
  appendLogLine(stripAnsi(headline))

  const formattedDetail = formatDetail(detail)
  if (!formattedDetail) return

  for (const line of formattedDetail.split("\n")) {
    console[method](colorize(line, COLOR_DARK_GRAY))
    appendLogLine(stripAnsi(line))
  }
}

function formatLogLine(level, scope, message) {
  const levelStyle = LEVEL_STYLES[level] || LEVEL_STYLES.info
  const prefix = [
    formatTimestamp(new Date()),
    `${colorize(levelStyle.label, ...levelStyle.codes)}${colorize(" -", COLOR_DARK_GRAY)}`,
  ]

  if (scope) {
    prefix.push(`${colorize(scope, COLOR_CYAN)}${colorize(" >", COLOR_DARK_GRAY)}`)
  }

  prefix.push(String(message || ""))
  return prefix.join(" ")
}

function formatTimestamp(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const seconds = String(date.getSeconds()).padStart(2, "0")
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function formatDetail(detail) {
  if (detail === undefined || detail === null) return ""
  if (detail instanceof Error) return detail.stack || detail.message || String(detail)
  if (typeof detail === "string") return detail
  return inspect(detail, {
    colors: USE_COLOR,
    depth: 6,
    breakLength: 120,
    compact: false,
    sorted: true,
  })
}

function colorize(value, ...codes) {
  const text = String(value)
  if (!USE_COLOR || !codes.length) return text
  return `\x1b[${codes.join(";")}m${text}${COLOR_RESET}`
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

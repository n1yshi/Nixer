const MAX_LINES = 4000

const lines = []

export function appendLogLine(line) {
  if (!line) return
  lines.push(String(line))
  if (lines.length > MAX_LINES) {
    lines.splice(0, lines.length - MAX_LINES)
  }
}

export function clearLogLines() {
  lines.splice(0, lines.length)
}

export function getLogText() {
  return `${lines.join("\n")}\n`
}

export function getLogFilenames() {
  return ["runtime.log"]
}


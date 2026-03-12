import os from "node:os"
import path from "node:path"

const defaultDataDir = path.join(os.homedir(), ".config", "NixerNodeFull")

export function getConfig() {
  const dataDir = process.env.NIXER_NODE_DATA_DIR || defaultDataDir

  return {
    appName: "Nixer",
    version: "node-port-dev",
    versionName: "Node Port Foundation",
    host: process.env.HOST || "0.0.0.0",
    port: Number.parseInt(process.env.PORT || "43211", 10),
    dataDir,
    dbPath: process.env.NIXER_NODE_DB_PATH || path.join(dataDir, "nixer-node.db"),
    uploadsDir: path.join(dataDir, "assets", "profiles"),
    logsDir: path.join(dataDir, "logs"),
    extensionsDir: path.join(dataDir, "extensions"),
    extensionUserConfigDir: path.join(dataDir, "extension-user-config"),
    pluginSettingsPath: path.join(dataDir, "plugin-settings.json"),
    publicDir: path.resolve(process.cwd(), "public"),
    serverPassword: process.env.NIXER_SERVER_PASSWORD || "",
  }
}

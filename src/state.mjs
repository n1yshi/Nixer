import os from "node:os"

import { defaultFeatureFlags } from "./defaults.mjs"
import { getAccount, getSettings, getTheme } from "./db.mjs"
import { newSimulatedUser } from "./user.mjs"

export function getStatus({ db, config, req }) {
  const account = getAccount(db)
  const settings = getSettings(db)
  const theme = getTheme(db)
  const activeUser = account && req.cookies && req.cookies["nixer_user_token"] === account.token
    ? {
      ...JSON.parse(account.viewer_json),
      token: "HIDDEN",
    }
    : newSimulatedUser()

  return {
    os: os.platform(),
    clientDevice: "desktop",
    clientPlatform: req.headers["sec-ch-ua-platform"] || "web",
    clientUserAgent: req.headers["user-agent"] || "",
    dataDir: config.dataDir,
    user: activeUser,
    settings,
    version: config.version,
    versionName: config.versionName,
    themeSettings: theme,
    isOffline: false,
    mediastreamSettings: {
      enabled: false,
      transcodeEnabled: false
    },
    torrentstreamSettings: {
      enabled: false,
      includeInLibrary: false
    },
    debridSettings: {
      enabled: false,
      provider: "none"
    },
    anilistClientId: "",
    updating: false,
    isDesktopSidecar: false,
    featureFlags: defaultFeatureFlags(),
    disabledFeatures: [],
    serverReady: true,
    serverHasPassword: Boolean(config.serverPassword),
    showChangelogTour: ""
  }
}

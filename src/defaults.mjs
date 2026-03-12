export function defaultSettings() {
  return {
    id: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    library: {
      libraryPath: "",
      autoUpdateProgress: true,
      disableUpdateCheck: false,
      torrentProvider: "none",
      autoSelectTorrentProvider: "none",
      autoScan: false,
      enableOnlinestream: true,
      includeOnlineStreamingInLibrary: true,
      disableAnimeCardTrailers: false,
      enableManga: true,
      dohProvider: "cloudflare",
      openTorrentClientOnStart: false,
      openWebURLOnStart: false,
      refreshLibraryOnStart: false,
      autoPlayNextEpisode: true,
      enableWatchContinuity: true,
      libraryPaths: [],
      autoSyncOfflineLocalData: true,
      scannerMatchingThreshold: 0.7,
      scannerMatchingAlgorithm: "hybrid",
      autoSyncToLocalAccount: true,
      autoSaveCurrentMediaOffline: true,
      useFallbackMetadataProvider: true,
      scannerUseLegacyMatching: false,
      scannerConfig: "",
      updateChannel: "nixer"
    },
    mediaPlayer: {
      defaultPlayer: "none",
      host: "",
      vlcUsername: "",
      vlcPassword: "",
      vlcPort: 0,
      vlcPath: "",
      mpcPort: 0,
      mpcPath: "",
      mpvSocket: "",
      mpvPath: "",
      mpvArgs: "",
      iinaSocket: "",
      iinaPath: "",
      iinaArgs: "",
      vcTranslate: false,
      vcTranslateTargetLanguage: "en",
      vcTranslateProvider: "",
      vcTranslateApiKey: ""
    },
    torrent: {
      defaultTorrentClient: "none",
      qbittorrentPath: "",
      qbittorrentHost: "",
      qbittorrentPort: 0,
      qbittorrentUsername: "",
      qbittorrentPassword: "",
      qbittorrentTags: "",
      qbittorrentCategory: "",
      transmissionPath: "",
      transmissionHost: "",
      transmissionPort: 0,
      transmissionUsername: "",
      transmissionPassword: "",
      showActiveTorrentCount: false,
      hideTorrentList: false
    },
    anilist: {
      hideAudienceScore: false,
      enableAdultContent: false,
      blurAdultContent: true,
      disableCacheLayer: false
    },
    manga: {
      defaultMangaProvider: "",
      mangaAutoUpdateProgress: true,
      mangaLocalSourceDirectory: ""
    },
    discord: {
      enableRichPresence: false,
      enableAnimeRichPresence: false,
      enableMangaRichPresence: false,
      richPresenceHideSeanimeRepositoryButton: true,
      richPresenceShowAniListMediaButton: false,
      richPresenceShowAniListProfileButton: false,
      richPresenceUseMediaTitleStatus: true
    },
    notifications: {
      disableNotifications: false,
      disableAutoDownloaderNotifications: false,
      disableAutoScannerNotifications: false
    },
    nakama: {
      enabled: false,
      username: "",
      isHost: false,
      hostPassword: "",
      remoteServerURL: "",
      remoteServerPassword: "",
      includeNakamaAnimeLibrary: false,
      hostShareLocalAnimeLibrary: false,
      hostUnsharedAnimeIds: [],
      hostEnablePortForwarding: false
    },
    autoDownloader: {
      provider: "none",
      interval: 20,
      enabled: false,
      downloadAutomatically: false,
      enableEnhancedQueries: true
    }
  }
}

export function defaultTheme() {
  return {
    id: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: "nixer",
    homeItems: defaultHomeItems()
  }
}

export function defaultFeatureFlags() {
  return {}
}

export function defaultHomeItems() {
  return [
    {
      id: "anime-continue-watching",
      type: "anime-continue-watching",
      schemaVersion: 1
    },
    {
      id: "anime-library",
      type: "anime-library",
      schemaVersion: 2,
      options: {
        statuses: ["CURRENT", "PAUSED", "PLANNING", "COMPLETED", "DROPPED"],
        layout: "grid"
      }
    }
  ]
}

(() => {
  const isDesktopShell = Boolean(window.nixerDesktopApp || window.electron);

  const EPISODE_SOURCE_PATH = "/api/v1/onlinestream/episode-source";
  const CONTINUITY_HISTORY_PATH = "/api/v1/continuity/history";
  const CONTINUITY_ITEM_PATH = "/api/v1/continuity/item/";
  const CONTINUITY_ITEM_MUTATION_PATH = "/api/v1/continuity/item";
  const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
  const MIN_RESTORE_TIME = 3;
  const MAX_DESKTOP_START_WINDOW = 8;
  const CARD_ENHANCER_STYLE_ID = "nixer-card-continuity-style";
  const RETRY_DELAYS_MS = isDesktopShell
    ? [0, 180, 450, 900, 1600, 2600, 3800, 5400]
    : [0, 120, 300, 700, 1400, 2200];

  const state = {
    currentEpisode: null,
    continuityByMediaId: new Map(),
    attachedVideos: new WeakSet(),
    retryTimers: new WeakMap(),
    appliedKeys: new WeakMap(),
    historyLoaded: false,
    historyPromise: null,
    enhanceScheduled: false,
  };

  const originalFetch = window.fetch?.bind(window);
  if (typeof originalFetch !== "function") {
    return;
  }

  window.fetch = async function patchedFetch(input, init) {
    const requestUrl = getRequestUrl(input);
    const requestMethod = getRequestMethod(input, init);
    captureEpisodeSourceRequest(requestUrl, input, init);
    captureContinuityMutationRequest(requestUrl, requestMethod);

    const response = await originalFetch(input, init);
    captureContinuityResponse(requestUrl, response, requestMethod);
    return response;
  };

  const observer = new MutationObserver(() => {
    attachToVideos(document.querySelectorAll("video"));
    scheduleEnhanceMediaCards();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  window.addEventListener("popstate", scheduleRestoreAllVideos);
  window.addEventListener("hashchange", scheduleRestoreAllVideos);
  window.addEventListener("popstate", scheduleEnhanceMediaCards);
  window.addEventListener("hashchange", scheduleEnhanceMediaCards);

  function start() {
    installCardEnhancerStyles();
    attachToVideos(document.querySelectorAll("video"));
    void loadContinuityHistory();
    scheduleEnhanceMediaCards();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function getRequestUrl(input) {
    try {
      if (typeof input === "string") return new URL(input, window.location.origin);
      if (input instanceof URL) return input;
      if (input && typeof input.url === "string") return new URL(input.url, window.location.origin);
    } catch {
      return null;
    }
    return null;
  }

  function getRequestMethod(input, init) {
    const method = init?.method ?? input?.method;
    return typeof method === "string" ? method.toUpperCase() : "GET";
  }

  function captureEpisodeSourceRequest(requestUrl, input, init) {
    if (!requestUrl || requestUrl.pathname !== EPISODE_SOURCE_PATH) {
      return;
    }

    const request = readRequestPayload(input, init);
    const mediaId = Number(request?.mediaId || 0);
    const episodeNumber = Number(request?.episodeNumber || 0);
    if (!mediaId || !episodeNumber) {
      return;
    }

    state.currentEpisode = {
      mediaId,
      episodeNumber,
      timestamp: Date.now(),
    };

    scheduleRestoreAllVideos();
  }

  function captureContinuityMutationRequest(requestUrl, requestMethod) {
    if (!requestUrl || requestUrl.pathname !== CONTINUITY_ITEM_MUTATION_PATH || requestMethod !== "PATCH") {
      return;
    }

    window.setTimeout(() => {
      void loadContinuityHistory(true);
    }, 150);
  }

  function captureContinuityResponse(requestUrl, response, requestMethod) {
    if (!requestUrl || !response || typeof response.clone !== "function") {
      return;
    }

    if (requestUrl.pathname === CONTINUITY_HISTORY_PATH) {
      response.clone().json()
        .then((payload) => {
          applyContinuityHistoryPayload(payload);
        })
        .catch(() => {});
      return;
    }

    if (!requestUrl.pathname.startsWith(CONTINUITY_ITEM_PATH) || requestMethod !== "GET") {
      return;
    }

    const mediaId = Number(requestUrl.pathname.slice(CONTINUITY_ITEM_PATH.length));
    if (!mediaId) {
      return;
    }

    response.clone().json()
      .then((payload) => {
        const data = payload && typeof payload === "object" ? payload.data : null;
        const item = data && data.found ? data.item : null;
        state.continuityByMediaId.set(mediaId, {
          found: Boolean(data?.found),
          item: item || null,
          timestamp: Date.now(),
        });
        scheduleRestoreAllVideos();
        scheduleEnhanceMediaCards();
      })
      .catch(() => {});
  }

  function applyContinuityHistoryPayload(payload) {
    const data = payload && typeof payload === "object" ? payload.data : null;
    const nextMap = new Map();

    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [mediaIdKey, rawItem] of Object.entries(data)) {
        const mediaId = Number(mediaIdKey);
        if (!mediaId) {
          continue;
        }
        nextMap.set(mediaId, {
          found: Boolean(rawItem),
          item: rawItem || null,
          timestamp: Date.now(),
        });
      }
    }

    state.continuityByMediaId = nextMap;
    state.historyLoaded = true;
    state.historyPromise = null;
    scheduleRestoreAllVideos();
    scheduleEnhanceMediaCards();
  }

  function loadContinuityHistory(force = false) {
    if (!force && state.historyLoaded) {
      return Promise.resolve(state.continuityByMediaId);
    }
    if (!force && state.historyPromise) {
      return state.historyPromise;
    }

    state.historyPromise = originalFetch(CONTINUITY_HISTORY_PATH, {
      credentials: "same-origin",
    })
      .then((response) => response.json())
      .then((payload) => {
        applyContinuityHistoryPayload(payload);
        return state.continuityByMediaId;
      })
      .catch(() => {
        state.historyPromise = null;
        return state.continuityByMediaId;
      });

    return state.historyPromise;
  }

  function readRequestPayload(input, init) {
    const body = init?.body ?? input?.body;
    if (typeof body !== "string") {
      return null;
    }

    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function attachToVideos(videos) {
    for (const video of videos) {
      if (!(video instanceof HTMLVideoElement) || state.attachedVideos.has(video)) {
        continue;
      }

      state.attachedVideos.add(video);
      for (const eventName of ["loadedmetadata", "canplay", "playing", "durationchange", "seeked", "timeupdate"]) {
        video.addEventListener(eventName, () => {
          scheduleRestore(video);
        });
      }
      scheduleRestore(video);
    }
  }

  function scheduleRestoreAllVideos() {
    for (const video of document.querySelectorAll("video")) {
      if (video instanceof HTMLVideoElement) {
        scheduleRestore(video);
      }
    }
  }

  function scheduleEnhanceMediaCards() {
    if (state.enhanceScheduled) {
      return;
    }

    state.enhanceScheduled = true;
    window.requestAnimationFrame(() => {
      state.enhanceScheduled = false;
      enhanceMediaCards();
    });
  }

  function scheduleRestore(video) {
    clearRetryTimer(video);
    let attemptIndex = 0;

    const runAttempt = () => {
      const applied = tryRestoreVideo(video);
      if (applied || attemptIndex >= RETRY_DELAYS_MS.length - 1) {
        return;
      }

      attemptIndex += 1;
      const timeoutId = window.setTimeout(runAttempt, RETRY_DELAYS_MS[attemptIndex]);
      state.retryTimers.set(video, timeoutId);
    };

    runAttempt();
  }

  function clearRetryTimer(video) {
    const timeoutId = state.retryTimers.get(video);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      state.retryTimers.delete(video);
    }
  }

  function tryRestoreVideo(video) {
    const target = getRestoreTarget();
    if (!target) {
      return false;
    }

    const targetKey = `${target.mediaId}:${target.episodeNumber}:${Math.round(target.time)}`;
    if (state.appliedKeys.get(video) === targetKey) {
      return true;
    }

    if (!(video.readyState >= 1)) {
      return false;
    }

    const duration = Number(video.duration || 0);
    const cappedTime = Number.isFinite(duration) && duration > 0
      ? Math.min(target.time, Math.max(0, duration - 1))
      : target.time;

    if (!(cappedTime >= MIN_RESTORE_TIME)) {
      return true;
    }

    const currentTime = Number(video.currentTime || 0);

    if (Math.abs(currentTime - cappedTime) <= 1.5) {
      state.appliedKeys.set(video, targetKey);
      return true;
    }

    if (currentTime > cappedTime + 2) {
      state.appliedKeys.set(video, targetKey);
      return true;
    }

    if (isDesktopShell && currentTime > MAX_DESKTOP_START_WINDOW && currentTime < cappedTime - 2) {
      return false;
    }

    try {
      video.currentTime = cappedTime;
      const updatedTime = Number(video.currentTime || 0);
      if (Math.abs(updatedTime - cappedTime) <= 2.5 || updatedTime >= cappedTime - 1) {
        state.appliedKeys.set(video, targetKey);
      }
      return false;
    } catch {
      return false;
    }
  }

  function getRestoreTarget() {
    const currentEpisode = state.currentEpisode;
    if (!currentEpisode || Date.now() - currentEpisode.timestamp > ACTIVE_WINDOW_MS) {
      return null;
    }

    const continuity = state.continuityByMediaId.get(currentEpisode.mediaId);
    const item = continuity?.item;
    if (!item) {
      return null;
    }

    const episodeNumber = Number(item.episodeNumber || 0);
    const currentTime = Number(item.currentTime || 0);
    const duration = Number(item.duration || 0);
    if (episodeNumber !== currentEpisode.episodeNumber) {
      return null;
    }
    if (!(currentTime >= MIN_RESTORE_TIME)) {
      return null;
    }
    if (duration > 0 && currentTime >= duration - 3) {
      return null;
    }

    return {
      mediaId: currentEpisode.mediaId,
      episodeNumber,
      time: currentTime,
    };
  }

  function installCardEnhancerStyles() {
    if (document.getElementById(CARD_ENHANCER_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = CARD_ENHANCER_STYLE_ID;
    style.textContent = `
      [data-nixer-continuity-progress-overlay] {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 0.36rem;
        background: rgba(12, 18, 28, 0.58);
        z-index: 12;
        overflow: hidden;
        pointer-events: none;
        border-top-left-radius: inherit;
        border-top-right-radius: inherit;
      }

      [data-nixer-continuity-progress-fill] {
        height: 100%;
        width: 0;
        background: linear-gradient(90deg, #f59e0b 0%, #f97316 100%);
        box-shadow: 0 0 14px rgba(249, 115, 22, 0.4);
        transition: width 180ms ease;
      }
    `;
    document.head.appendChild(style);
  }

  function enhanceMediaCards() {
    const cards = document.querySelectorAll('[data-media-entry-card-container][data-media-type="anime"]');
    for (const card of cards) {
      if (!(card instanceof HTMLElement)) {
        continue;
      }

      const mediaId = Number(card.dataset.mediaId || 0);
      if (!mediaId) {
        continue;
      }

      const continuity = normalizeContinuityItem(state.continuityByMediaId.get(mediaId)?.item);
      updateCardProgressOverlay(card, continuity);
      updateCardContinueLabel(card, continuity);
    }
  }

  function normalizeContinuityItem(item) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const episodeNumber = Number(item.episodeNumber || 0);
    const currentTime = Number(item.currentTime || 0);
    const duration = Number(item.duration || 0);
    if (!episodeNumber || !(currentTime > 0) || !(duration > 0)) {
      return null;
    }

    return {
      episodeNumber,
      currentTime,
      duration,
      progressPercent: Math.max(0, Math.min(100, (currentTime / duration) * 100)),
    };
  }

  function hasResumeProgress(item) {
    if (!item) {
      return false;
    }

    return item.currentTime >= MIN_RESTORE_TIME && item.currentTime < item.duration - 3;
  }

  function updateCardProgressOverlay(card, continuity) {
    const host = getCardImageHost(card);
    if (!host) {
      return;
    }

    let overlay = host.querySelector("[data-nixer-continuity-progress-overlay]");
    if (!hasResumeProgress(continuity)) {
      overlay?.remove();
      return;
    }

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute("data-nixer-continuity-progress-overlay", "true");
      overlay.innerHTML = '<div data-nixer-continuity-progress-fill="true"></div>';
      host.appendChild(overlay);
    }

    const fill = overlay.querySelector("[data-nixer-continuity-progress-fill]");
    if (fill instanceof HTMLElement) {
      fill.style.width = `${continuity.progressPercent}%`;
    }
    overlay.title = `Episode ${continuity.episodeNumber} • ${formatTime(continuity.currentTime)} / ${formatTime(continuity.duration)}`;
  }

  function getCardImageHost(card) {
    const badgeContainer = card.querySelector("[data-media-entry-card-body-progress-badge-container]");
    if (badgeContainer instanceof HTMLElement && badgeContainer.parentElement instanceof HTMLElement) {
      return badgeContainer.parentElement;
    }

    const gradient = card.querySelector("[data-media-card-body-bottom-gradient]");
    if (gradient instanceof HTMLElement && gradient.parentElement instanceof HTMLElement) {
      return gradient.parentElement;
    }

    return card;
  }

  function updateCardContinueLabel(card, continuity) {
    const nextLabel = hasResumeProgress(continuity) ? "Continue" : "Watch";
    const actionNodes = card.querySelectorAll("button, a");

    for (const actionNode of actionNodes) {
      if (!(actionNode instanceof HTMLElement)) {
        continue;
      }

      const text = normalizeText(actionNode.textContent);
      if (text !== "Watch" && text !== "Continue") {
        continue;
      }

      replaceActionLabel(actionNode, nextLabel);
    }
  }

  function replaceActionLabel(element, nextLabel) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let changed = false;

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const textValue = normalizeText(textNode.nodeValue);
      if (textValue === "Watch" || textValue === "Continue") {
        textNode.nodeValue = textNode.nodeValue.replace(/Watch|Continue/g, nextLabel);
        changed = true;
      }
    }

    if (!changed) {
      element.appendChild(document.createTextNode(nextLabel));
    }
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function formatTime(value) {
    const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
})();

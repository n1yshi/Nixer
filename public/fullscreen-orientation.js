(() => {
  const getFullscreenElement = () =>
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    null;

  const lockLandscape = async () => {
    try {
      if (typeof screen === "undefined") return;
      const orientation = screen.orientation;
      if (orientation && typeof orientation.lock === "function") {
        await orientation.lock("landscape");
        return;
      }
      const anyScreen = screen;
      if (typeof anyScreen.lockOrientation === "function") anyScreen.lockOrientation("landscape");
      else if (typeof anyScreen.mozLockOrientation === "function") anyScreen.mozLockOrientation("landscape");
      else if (typeof anyScreen.msLockOrientation === "function") anyScreen.msLockOrientation("landscape");
    } catch {
    }
  };

  const unlockOrientation = () => {
    try {
      if (typeof screen === "undefined") return;
      const orientation = screen.orientation;
      if (orientation && typeof orientation.unlock === "function") {
        orientation.unlock();
        return;
      }
      const anyScreen = screen;
      if (typeof anyScreen.unlockOrientation === "function") anyScreen.unlockOrientation();
      else if (typeof anyScreen.mozUnlockOrientation === "function") anyScreen.mozUnlockOrientation();
      else if (typeof anyScreen.msUnlockOrientation === "function") anyScreen.msUnlockOrientation();
    } catch {
    }
  };

  let didTryLock = false;
  const onFullscreenChange = () => {
    if (getFullscreenElement()) {
      didTryLock = true;
      void lockLandscape();
    } else if (didTryLock) {
      didTryLock = false;
      unlockOrientation();
    }
  };

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("mozfullscreenchange", onFullscreenChange);
  document.addEventListener("MSFullscreenChange", onFullscreenChange);

  const attachIOSVideoListeners = (video) => {
    if (!video || video.__nixerFullscreenOrientation) return;
    video.__nixerFullscreenOrientation = true;
    video.addEventListener("webkitbeginfullscreen", () => void lockLandscape(), { passive: true });
    video.addEventListener("webkitendfullscreen", () => unlockOrientation(), { passive: true });
  };

  const scanAddedNode = (node) => {
    if (!node) return;
    if (node.nodeType !== 1) return;
    if (node.tagName === "VIDEO") attachIOSVideoListeners(node);
    if (node.querySelectorAll) node.querySelectorAll("video").forEach(attachIOSVideoListeners);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) scanAddedNode(node);
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.querySelectorAll("video").forEach(attachIOSVideoListeners);
})();

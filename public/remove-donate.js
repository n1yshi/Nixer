(() => {
  const KEYWORDS = [
    "donate",
    "donation",
    "spenden",
    "sponsor",
    "sponsoring",
    "ko-fi",
    "kofi",
    "patreon",
    "buymeacoffee",
    "coffee",
    "paypal",
    "github.com/sponsors",
  ];

  const normalize = (value) => String(value || "").toLowerCase();

  const isSettingsRoute = () => {
    const path = normalize(window.location?.pathname);
    const hash = normalize(window.location?.hash);
    return path.includes("/settings") || hash.includes("settings");
  };

  const shouldRemove = (element) => {
    if (!element) return false;
    const tag = String(element.tagName || "").toUpperCase();
    if (tag !== "A" && tag !== "BUTTON") return false;

    const text = normalize(element.textContent);
    const title = normalize(element.getAttribute?.("title"));
    const ariaLabel = normalize(element.getAttribute?.("aria-label"));
    const href = tag === "A" ? normalize(element.getAttribute?.("href")) : "";

    const haystack = [text, title, ariaLabel, href].join(" ");
    return KEYWORDS.some((keyword) => haystack.includes(keyword));
  };

  const removeDonateButtons = () => {
    if (!isSettingsRoute()) return;
    const root = document.getElementById("root") || document;
    const candidates = root.querySelectorAll("a, button");
    for (const element of candidates) {
      if (shouldRemove(element)) element.remove();
    }
  };

  const schedule = (() => {
    let raf = 0;
    return () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        removeDonateButtons();
      });
    };
  })();

  const observer = new MutationObserver(() => schedule());
  const start = () => {
    schedule();
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  };

  window.addEventListener("popstate", schedule);
  window.addEventListener("hashchange", schedule);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

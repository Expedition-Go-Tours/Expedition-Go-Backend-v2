/** @see https://www.tawk.to/knowledgebase/ - global API on window.Tawk_API */

const TAUK_SCRIPT_ID = "tawk-to-support-script";
const TAUK_SRC = "https://embed.tawk.to/644922ef31ebfa0fe7fa8b14/1guur0u4t";

let hooksBound = false;

function bindDefaultHooks() {
  if (hooksBound || typeof window === "undefined") return;
  hooksBound = true;

  /* ── Prevent Tawk.to from mutating page title with unread badges ── */
  const titleEl = document.querySelector("title");
  let lastRealTitle = document.title;
  if (titleEl) {
    new MutationObserver(() => {
      const current = document.title;
      /* Tawk.to injects patterns like "(1) Page Title" or "1 Message - Page Title" */
      const isTawkSpam = /^\(\d+\)\s+|\d+\s*Message/i.test(current);
      if (isTawkSpam) {
        document.title = lastRealTitle;
      } else {
        lastRealTitle = current;
      }
    }).observe(titleEl, { childList: true, subtree: true });
  }

  window.Tawk_API = window.Tawk_API || {};
  window.Tawk_API.onLoad = function onLoad() {
    if (typeof window.Tawk_API?.hideWidget === "function") {
      window.Tawk_API.hideWidget();
    }
  };
  window.Tawk_API.onChatMinimized = function onChatMinimized() {
    if (typeof window.Tawk_API?.hideWidget === "function") {
      window.Tawk_API.hideWidget();
    }
  };
  window.Tawk_API.onChatHidden = function onChatHidden() {
    if (typeof window.Tawk_API?.hideWidget === "function") {
      window.Tawk_API.hideWidget();
    }
  };
}

/**
 * Injects the widget script once. Keeps the bubble hidden until {@link openTawkChat}.
 */
export function loadTawkScript() {
  if (typeof window === "undefined") return;
  bindDefaultHooks();
  if (document.getElementById(TAUK_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = TAUK_SCRIPT_ID;
  script.async = true;
  script.src = TAUK_SRC;
  script.setAttribute("crossorigin", "anonymous");
  document.body.appendChild(script);
}

/**
 * Show and focus the Tawk.to widget (loads script on first call if needed).
 */
export function openTawkChat() {
  if (typeof window === "undefined") return;
  loadTawkScript();

  const tryOpen = (attempt) => {
    const tawk = window.Tawk_API;
    if (!tawk) {
      if (attempt < 20) setTimeout(() => tryOpen(attempt + 1), 300);
      return;
    }
    if (typeof tawk.showWidget === "function") tawk.showWidget();
    if (typeof tawk.unhideWidget === "function") tawk.unhideWidget();
    if (typeof tawk.maximize === "function") return tawk.maximize();
    if (typeof tawk.openWidget === "function") return tawk.openWidget();
  };

  tryOpen(0);
}

export function hideTawkWidget() {
  if (typeof window === "undefined" || !window.Tawk_API) return;
  if (typeof window.Tawk_API.minimize === "function") {
    window.Tawk_API.minimize();
  }
  if (typeof window.Tawk_API.hideWidget === "function") {
    window.Tawk_API.hideWidget();
  }
}

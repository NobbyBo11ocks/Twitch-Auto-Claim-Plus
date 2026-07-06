(() => {
  "use strict";

  const STYLE_ID = "twitch-tools-theme-style";
  const NAV_STYLE_ID = "twitch-tools-nav-style";
  const NAV_BUTTON_ID = "twitch-tools-nav-button";
  const NAV_PANEL_ID = "twitch-tools-nav-panel";
  const ELLIPSIS_SELECTOR = '[data-a-target="ellipsis-button"]';
  const CLAIM_COOLDOWN_MS = 5000;
  const SCAN_INTERVAL_MS = 15000;
  const CLAIM_MUTATION_THROTTLE_MS = 2500;
  const SETTINGS_KEYS = Object.keys(DEFAULTS);
  const CLAIM_SESSION_TOTAL_KEY = "twitchToolsClaimSessionTotal";

  let settings = { ...DEFAULTS };
  let lastClaimAt = 0;
  let lastClaimAmount = 0;
  let lastClaimSource = null; // "text" | "points-add-indicator" | null - which method supplied lastClaimAmount, for diagnostics
  let totalClaimedPoints = 0;
  let scanTimer = null;
  let observer = null;
  let observedRoot = null;
  let queuedScan = 0;
  let navPanelOpen = false;

  const safeStorageGet = (keys) =>
    new Promise((resolve) => {
      try {
        chrome.storage.sync.get(keys, resolve);
      } catch {
        resolve({});
      }
    });

  const safeStorageRemove = (keys, callback = () => {}) => {
    try {
      chrome.storage.sync.remove(keys, () => {
        void chrome.runtime.lastError;
        callback();
      });
    } catch {
      callback();
    }
  };

  const safeStorageSet = (values) => {
    safeStorageRemove(DEPRECATED_SETTINGS_KEYS, () => {
      try {
        chrome.storage.sync.set(values);
      } catch {
        // Storage can be unavailable on restricted pages.
      }
    });
  };

  const safeLocalGet = (keys) =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, resolve);
      } catch {
        resolve({});
      }
    });

  const safeLocalSet = (values) => {
    try {
      chrome.storage.local.set(values);
    } catch {
      // Local storage can be unavailable on restricted pages.
    }
  };

  const persistClaimSessionTotal = (amount) => {
    safeLocalGet({ [CLAIM_SESSION_TOTAL_KEY]: 0 }).then((stored) => {
      const latestAcrossTabs = Number(stored?.[CLAIM_SESSION_TOTAL_KEY]) || 0;
      const next = latestAcrossTabs + amount;
      totalClaimedPoints = next;
      safeLocalSet({ [CLAIM_SESSION_TOTAL_KEY]: next });
      renderNavPanel();
    });
  };

  const resetPointsTotal = () => {
    totalClaimedPoints = 0;
    safeLocalSet({ [CLAIM_SESSION_TOTAL_KEY]: 0 });
  };

  const isVisible = (element) => {
    if (!element || !(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.pointerEvents !== "none"
    );
  };

  const readableText = (element) => {
    const attributes = ["aria-label", "title", "data-a-target", "data-test-selector"];
    const attrText = attributes.map((name) => element.getAttribute(name) || "").join(" ");
    const text = element.textContent || "";
    const nearby = element.closest("[data-a-target], [data-test-selector], [class]")?.textContent || "";
    return `${attrText} ${text} ${nearby}`.replace(/\s+/g, " ").trim();
  };

  const isLikelyClaimButton = (element) => {
    if (!element || !(element instanceof HTMLElement)) return false;
    const role = element.getAttribute("role") || "";
    const tag = element.tagName.toLowerCase();
    if (tag !== "button" && role !== "button") return false;
    if (!isVisible(element)) return false;
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;

    const text = readableText(element).toLowerCase();
    const strongMatch =
      /claim\s+bonus/.test(text) ||
      /bonus\s+claim/.test(text) ||
      /claim.*channel.*point/.test(text) ||
      /channel.*point.*claim/.test(text) ||
      /claim.*community.*point/.test(text) ||
      /community.*point.*claim/.test(text);

    const targetMatch =
      /(bonus|claim)/.test(text) &&
      /(channel-points|channel points|community-points|community points|points-reward|reward-center)/.test(text);

    return strongMatch || targetMatch;
  };

  const scoreClaimButton = (element) => {
    const text = readableText(element).toLowerCase();
    let score = 0;

    if (/claim\s+bonus|bonus\s+claim/.test(text)) score += 10;
    if (/channel\s*points?|community\s*points?/.test(text)) score += 8;
    if (/claim/.test(text)) score += 5;
    if (/bonus|reward/.test(text)) score += 4;
    if (/data-a-target|data-test-selector/.test(text)) score += 1;

    const rect = element.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.45) score += 2;
    if (rect.left > window.innerWidth * 0.45) score += 1;

    return score;
  };

  const candidateButtons = () => {
    const selectors = [
      'button[aria-label*="Claim" i]',
      'button[aria-label*="Bonus" i]',
      'button[title*="Claim" i]',
      'button[title*="Bonus" i]',
      'button[data-a-target*="bonus" i]',
      'button[data-a-target*="claim" i]',
      'button[data-a-target*="community-points" i]',
      'button[data-test-selector*="bonus" i]',
      'button[data-test-selector*="claim" i]',
      'button[data-test-selector*="community" i]',
      '[role="button"][aria-label*="Claim" i]',
      '[role="button"][aria-label*="Bonus" i]',
      '[role="button"][data-test-selector*="claim" i]',
      '[role="button"][data-test-selector*="bonus" i]'
    ];

    return Array.from(document.querySelectorAll(selectors.join(",")))
      .filter(isLikelyClaimButton)
      .sort((a, b) => {
        const scoreDiff = scoreClaimButton(b) - scoreClaimButton(a);
        if (scoreDiff !== 0) return scoreDiff;

        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.top - bRect.top || aRect.left - bRect.left;
      });
  };

  const parsePointsNumber = (value) => {
    if (!value) return 0;
    const cleaned = String(value).replace(/[,\s]/g, "");
    const number = Number(cleaned);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };

  const extractClaimAmount = (button) => {
    if (!button) return 0;

    const sources = [
      button.getAttribute("aria-label") || "",
      button.getAttribute("title") || "",
      button.textContent || "",
      button.parentElement?.textContent || "",
      button.closest('[data-test-selector], [data-a-target], section, div')?.textContent || ""
    ]
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const patterns = [
      /(?:claim|bonus|reward)[^\d]{0,24}(\d[\d,]*)\s*(?:channel\s*)?points?/i,
      /(\d[\d,]*)\s*(?:channel\s*)?points?/i,
      /\+(\d[\d,]*)\b/i
    ];

    for (const source of sources) {
      for (const pattern of patterns) {
        const match = source.match(pattern);
        const amount = parsePointsNumber(match?.[1] || "");
        if (amount > 0 && amount <= 1000000) return amount;
      }
    }

    return 0;
  };

  const isDashboardHost = () => /(^|\.)dashboard\.twitch\.tv$/i.test(location.hostname);

  // Twitch's actual claim button never carries the reward size in its own
  // accessible text - a real capture from live Twitch shows aria-label is
  // just "Claim Bonus" with no data-test-selector, no data-a-target, and no
  // text at all, so extractClaimAmount above only pays off on a hypothetical
  // UI variant that embeds a number; in the ordinary case it returns 0.
  //
  // An earlier version of this file tried to infer the claimed amount by
  // reading the viewer's persistent points balance before and after a claim
  // and diffing the two. Confirmed against a real capture that this doesn't
  // work: Twitch renders that balance in abbreviated form once it's large
  // enough ("61.1K", not "61,100"), which never matched a plain-number read,
  // and even if parsed, a rounded display can't reliably reveal a change as
  // small as a single claim - "61.1K" covers a range of exact values wider
  // than most bonus sizes, so a diff against it would often be silently wrong
  // rather than silently missing, which is worse.
  //
  // The same capture showed a better, exact signal instead: Twitch shows a
  // "+<amount>" indicator (seen as class community-points-summary__points-add-text)
  // in the community-points-summary widget when points are earned - literally
  // "+60" for a 60-point claim. That's read directly below, not inferred from
  // a diff of anything.
  const POINTS_ADD_SELECTORS = [
    '[class*="points-add-text" i]',
    '[class*="community-points-summary__points-add" i]',
    '[data-test-selector*="points-add" i]'
  ];

  const POINTS_ADD_PATTERN = /^\+\s*(\d[\d,]*)/;
  const POINTS_ADD_POLL_INTERVAL_MS = 200;
  const POINTS_ADD_POLL_TIMEOUT_MS = 3000;

  // Returns the raw "+N" text currently visible (or null) - claimBonus needs
  // the raw text, not just a parsed number, to tell "nothing here" apart from
  // "the same leftover indicator from an earlier claim is still on screen."
  const readPointsAddText = () => {
    for (const selector of POINTS_ADD_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        const text = (el.textContent || "").trim();
        if (POINTS_ADD_PATTERN.test(text)) return text;
      }
    }
    return null;
  };

  // Polls for the indicator to appear (or change, if one was already present
  // from an earlier claim) instead of checking once after a fixed delay -
  // it's a brief animated toast, not a persistent value, so exact timing
  // varies claim to claim. Stops as soon as it finds a new one, or gives up
  // after POINTS_ADD_POLL_TIMEOUT_MS (comfortably inside CLAIM_COOLDOWN_MS,
  // so two polling windows can never overlap).
  const watchForPointsAdd = (previousText, onResolved) => {
    const deadline = Date.now() + POINTS_ADD_POLL_TIMEOUT_MS;

    const check = () => {
      const text = readPointsAddText();
      if (text && text !== previousText) {
        const amount = parsePointsNumber((text.match(POINTS_ADD_PATTERN) || [])[1] || "");
        onResolved(amount > 0 ? amount : null);
        return;
      }
      if (Date.now() >= deadline) {
        onResolved(null);
        return;
      }
      window.setTimeout(check, POINTS_ADD_POLL_INTERVAL_MS);
    };

    check();
  };

  const claimBonus = () => {
    if (!settings.autoClaim) return;
    if (isDashboardHost()) return;
    if (Date.now() - lastClaimAt < CLAIM_COOLDOWN_MS) return;

    const button = candidateButtons()[0];
    if (!button) return;

    lastClaimAt = Date.now();

    const textAmount = extractClaimAmount(button);
    // Only worth capturing this up-front if we'll actually need it - skip it
    // entirely on the fast path where the button's own text already gave us
    // a usable number.
    const previousPointsAddText = textAmount > 0 ? null : readPointsAddText();

    button.click();

    if (textAmount > 0) {
      lastClaimAmount = textAmount;
      lastClaimSource = "text";
      totalClaimedPoints += textAmount;
      renderNavPanel();
      persistClaimSessionTotal(textAmount);
      return;
    }

    watchForPointsAdd(previousPointsAddText, (amount) => {
      if (amount === null) return; // Nothing usable found - leave the total untouched rather than guess.
      lastClaimAmount = amount;
      lastClaimSource = "points-add-indicator";
      totalClaimedPoints += amount;
      renderNavPanel();
      persistClaimSessionTotal(amount);
    });
  };

  const queueClaimScan = (delay = CLAIM_MUTATION_THROTTLE_MS) => {
    if (!settings.autoClaim || queuedScan) return;
    queuedScan = window.setTimeout(() => {
      queuedScan = 0;
      claimBonus();
    }, delay);
  };

  const nodeMightContainClaimButton = (node) => {
    if (!(node instanceof HTMLElement)) return false;

    const selector = 'button,[role="button"],[aria-label],[title],[data-a-target]';
    const target = node.matches(selector) ? node : node.querySelector?.(selector);
    if (!target) return false;

    const marker = [
      target.getAttribute?.("aria-label") || "",
      target.getAttribute?.("title") || "",
      target.getAttribute?.("data-a-target") || "",
      target.textContent?.slice(0, 160) || ""
    ].join(" ").toLowerCase();

    return /(claim|bonus|channel[- ]?points|community[- ]?points|reward)/.test(marker);
  };

  const mutationMightContainClaimButton = (mutations) =>
    mutations.some((mutation) => {
      if (mutation.type === "attributes") {
        return nodeMightContainClaimButton(mutation.target);
      }
      return Array.from(mutation.addedNodes).some(nodeMightContainClaimButton);
    });

  const getObserverRoot = () => document.body || document.documentElement || null;

  const ensureScanObserver = () => {
    const root = getObserverRoot();
    if (!root) return false;
    if (observer && observedRoot === root) return true;

    if (observer) observer.disconnect();
    observedRoot = root;
    observer = new MutationObserver((mutations) => {
      if (mutationMightContainClaimButton(mutations)) queueClaimScan();
      ensureNavButton();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-disabled", "disabled", "title", "data-a-target", "data-test-selector"]
    });
    return true;
  };

  const chatTuningCss = (rawSettings) => {
    const s = normalizeSettings(rawSettings);
    if (s.fontScale === 100) return "";

    const scale = (s.fontScale / 100).toFixed(2);
    const lineHeight = Math.max(1.35, 1.35 + ((s.fontScale - 100) / 100) * 0.35).toFixed(2);
    const rowPadding = s.fontScale >= 104 ? `${Math.min(3, Math.round((s.fontScale - 100) / 4))}px` : "0px";

    const chatRows = `
      [data-a-target="chat-scroller"] [data-a-target="chat-line-message"],
      [data-a-target="chat-scroller"] [data-test-selector="chat-line-message"],
      [data-a-target="chat-line-message"],
      [data-test-selector="chat-line-message"],
      [class*="chat-line__message"],
      [class*="chat-line"]
    `;

    const messageText = `
      [data-a-target="chat-message-text"],
      [data-test-selector="chat-message-text"],
      [data-a-target="chat-line-message-body"],
      [data-test-selector="chat-line-message-body"],
      [data-a-target="chat-line-message"] .text-fragment,
      [data-test-selector="chat-line-message"] .text-fragment,
      [data-a-target="chat-line-message"] [class*="text-fragment"],
      [data-test-selector="chat-line-message"] [class*="text-fragment"],
      [data-a-target="chat-line-message"] [class*="message-text"],
      [data-test-selector="chat-line-message"] [class*="message-text"],
      [data-a-target="chat-line-message"] [class*="message"] span,
      [data-test-selector="chat-line-message"] [class*="message"] span,
      [data-a-target="chat-line-message"] *:not(img):not(svg):not(button):not([class*="badge"]):not([class*="emote"]),
      [data-test-selector="chat-line-message"] *:not(img):not(svg):not(button):not([class*="badge"]):not([class*="emote"]),
      [class*="chat-line__message"] .text-fragment,
      [class*="chat-line__message"] [class*="text-fragment"],
      [class*="chat-line__message"] [class*="message-text"],
      [class*="chat-line__message"] span:not([class*="badge"]):not([class*="author"]):not([class*="username"]),
      [class*="seventv-message"],
      [class*="seventv-message"] span,
      [class*="ffz--inline"],
      [class*="bttv-emote"]
    `;

    return `
      :root {
        --twitch-tools-chat-font-scale: ${scale};
        --twitch-tools-chat-font-size: calc(13px * var(--twitch-tools-chat-font-scale));
        --twitch-tools-chat-line-height: ${lineHeight};
        --twitch-tools-chat-row-padding: ${rowPadding};
      }

      ${chatRows} {
        line-height: var(--twitch-tools-chat-line-height) !important;
        padding-top: var(--twitch-tools-chat-row-padding) !important;
        padding-bottom: var(--twitch-tools-chat-row-padding) !important;
      }

      ${messageText} {
        font-size: var(--twitch-tools-chat-font-size) !important;
        line-height: var(--twitch-tools-chat-line-height) !important;
        overflow-wrap: anywhere;
      }
    `;
  };

  const chatCss = (p) => {
    return `
      /* Keep Twitch's native composer layout stable and only recolour internals. */
      [data-a-target="chat-input"],
      [data-test-selector="chat-input"],
      form[data-a-target="chat-send-message-form"] {
        background: transparent !important;
        border: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }

      [data-a-target="chat-input"] > div,
      [data-test-selector="chat-input"] > div,
      form[data-a-target="chat-send-message-form"] > div {
        box-shadow: none !important;
      }

      [data-a-target="chat-input"] [contenteditable="true"],
      [data-test-selector="chat-input"] [contenteditable="true"],
      form[data-a-target="chat-send-message-form"] [contenteditable="true"] {
        background: transparent !important;
        color: ${p.text} !important;
        border: 0 !important;
        box-shadow: none !important;
        padding-left: 0.85rem !important;
        padding-right: 0.85rem !important;
      }

      [data-a-target="chat-input"] button,
      [data-test-selector="chat-input"] button,
      form[data-a-target="chat-send-message-form"] button,
      [data-a-target="chat-input"] [role="button"],
      [data-test-selector="chat-input"] [role="button"],
      form[data-a-target="chat-send-message-form"] [role="button"] {
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
      }

      [data-a-target="chat-input"] svg,
      [data-test-selector="chat-input"] svg,
      form[data-a-target="chat-send-message-form"] svg {
        color: ${p.muted} !important;
        fill: currentColor !important;
      }
    `;
  };


  const accentCss = (accent) => {
    if ((accent || "").toLowerCase() === DEFAULTS.accent.toLowerCase()) return "";
    return `
      :root {
        --twitch-tools-accent: ${accent};
        --color-text-link: ${accent} !important;
        --color-text-link-hover: ${accent} !important;
        --color-accent: ${accent} !important;
        --color-accent-label: ${accent} !important;
        --color-fill-brand: ${accent} !important;
        --color-fill-button-primary: ${accent} !important;
        --color-fill-button-primary-hover: ${accent} !important;
        --color-background-button-primary-default: ${accent} !important;
        --color-background-button-primary-hover: ${accent} !important;
      }
    `;
  };

  const themeCss = (rawSettings) => {
    const s = normalizeSettings(rawSettings);
    const tuningCss = chatTuningCss(s);
    const activeTheme = Boolean(s.themeEnabled && s.theme !== "default");
    const p = activeTheme ? (THEME_PRESETS[s.theme] || THEME_PRESETS.midnight) : null;
    const accent = s.accent;
    const looseStyling = !activeTheme ? accentCss(accent) : "";

    // Dedicated, uniquely-prefixed variables for our own injected UI (the nav
    // panel). Always set explicitly here, in both branches, so that UI never
    // silently inherits Twitch's own same-named design tokens (e.g. Twitch already
    // defines its own --color-border-base for its native dark/light mode) when no
    // theme is active.
    const panelVars = `
      :root {
        --twitch-tools-accent: ${accent};
        --twitch-tools-panel-bg: ${activeTheme ? p.surface : "#0e0e10"};
        --twitch-tools-panel-border: ${activeTheme ? p.border : "rgba(255, 255, 255, 0.12)"};
        --twitch-tools-panel-text: ${activeTheme ? p.text : "#f3f3f5"};
        --twitch-tools-panel-muted: ${activeTheme ? p.muted : "#8d8d97"};
        --twitch-tools-panel-input-bg: ${activeTheme ? p.surface2 : "#17171b"};
      }
    `;

    if (!activeTheme) return `${panelVars}
${looseStyling}
${tuningCss}`;

    return `
      ${panelVars}
      :root {
        --color-background-body: ${p.bg} !important;
        --color-background-base: ${p.base} !important;
        --color-background-alt: ${p.surface} !important;
        --color-background-alt-2: ${p.surface2} !important;
        --color-background-float: ${p.surface} !important;
        --color-border-base: ${p.border} !important;
        --color-border-region: ${p.border} !important;
        --color-text-base: ${p.text} !important;
        --color-text-alt: ${p.muted} !important;
        --color-text-link: ${accent} !important;
        --color-text-link-hover: ${accent} !important;
        --color-accent: ${accent} !important;
        --color-accent-label: ${accent} !important;
        --color-fill-brand: ${accent} !important;
        --color-fill-button-primary: ${accent} !important;
        --color-fill-button-primary-hover: ${accent} !important;
        --color-background-button-primary-default: ${accent} !important;
        --color-background-button-primary-hover: ${accent} !important;
      }

      body,
      #root,
      .tw-root--theme-dark,
      .tw-root--theme-light {
        background: ${p.bg} !important;
        color: ${p.text} !important;
      }

      main,
      header,
      nav,
      aside,
      [data-a-target="chat-room-component-layout"],
      [data-a-target="chat-scroller"],
      [data-a-target="side-nav-card"],
      [data-a-target="channel-header"],
      .side-nav,
      .channel-root__right-column,
      .persistent-player,
      .top-nav,
      .chat-room,
      .stream-chat {
        background-color: ${p.base} !important;
        color: ${p.text} !important;
      }

      /* Exclude range/checkbox/radio/color/file inputs: browsers render these as
         native widgets (e.g. the player's volume slider is a plain
         <input type="range">), and forcing a background/border here paints a
         visible box behind the native track/thumb instead of recoloring it. */
      input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"]):not([type="image"]),
      textarea,
      select,
      [contenteditable="true"],
      [data-a-target="tw-input"] {
        color: ${p.text} !important;
        border-color: ${p.border} !important;
      }

      input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"]):not([type="image"]),
      textarea,
      select {
        background-color: ${p.input} !important;
      }

      a,
      a:visited,
      [data-a-target="chat-message-username"],
      .chat-author__display-name,
      .tw-link,
      .tw-link:visited {
        color: ${accent} !important;
      }

      .scrollable-area,
      .simplebar-content,
      .tw-card,
      .tw-box,
      .Layout-sc-1xcs6mc-0,
      [class*="Layout"] {
        scrollbar-color: ${accent} ${p.base} !important;
      }

      ::selection {
        background: ${accent} !important;
        color: ${p.buttonText} !important;
      }

      ${chatCss(p)}
      ${tuningCss}
    `;
  };

  const injectNavStyle = () => {
    if (document.getElementById(NAV_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = NAV_STYLE_ID;
    style.textContent = `
      #${NAV_BUTTON_ID} {
        all: unset;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        margin-left: 4px;
        border-radius: 4px;
        cursor: pointer;
        color: #efeff1;
        box-sizing: border-box;
      }
      #${NAV_BUTTON_ID}:hover,
      #${NAV_BUTTON_ID}:focus-visible {
        background: rgba(255, 255, 255, 0.1);
      }
      #${NAV_BUTTON_ID} img {
        display: block;
        width: 18px;
        height: 18px;
        pointer-events: none;
      }

      #${NAV_PANEL_ID} {
        all: initial;
        display: block;
        position: fixed;
        z-index: 2147483647;
        width: 260px;
        background: var(--twitch-tools-panel-bg, #0e0e10);
        border: 1px solid var(--twitch-tools-panel-border, rgba(255, 255, 255, 0.12));
        border-radius: 12px;
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
        padding: 12px;
        font-family: Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--twitch-tools-panel-text, #f3f3f5);
        font-size: 13px;
        line-height: 1.4;
      }
      #${NAV_PANEL_ID}[hidden] {
        display: none;
      }
      #${NAV_PANEL_ID} .ttnp-arrow {
        position: absolute;
        top: -7px;
        left: 20px;
        width: 12px;
        height: 12px;
        background: var(--twitch-tools-panel-bg, #0e0e10);
        border-left: 1px solid var(--twitch-tools-panel-border, rgba(255, 255, 255, 0.12));
        border-top: 1px solid var(--twitch-tools-panel-border, rgba(255, 255, 255, 0.12));
        transform: rotate(45deg);
        border-radius: 2px 0 0 0;
      }
      #${NAV_PANEL_ID} * {
        box-sizing: border-box;
        font-family: inherit;
        color: inherit;
        margin: 0;
        padding: 0;
      }
      #${NAV_PANEL_ID} button,
      #${NAV_PANEL_ID} select {
        font: inherit;
        appearance: none;
        -webkit-appearance: none;
        background: none;
        border: 0;
        cursor: pointer;
      }
      #${NAV_PANEL_ID} .ttnp-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 10px;
        margin-bottom: 8px;
        border-bottom: 1px solid var(--twitch-tools-panel-border, rgba(255, 255, 255, 0.08));
      }
      #${NAV_PANEL_ID} .ttnp-logo {
        width: 20px;
        height: 20px;
        display: block;
      }
      #${NAV_PANEL_ID} .ttnp-title {
        font-weight: 700;
        font-size: 13px;
      }
      #${NAV_PANEL_ID} .ttnp-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 7px 0;
      }
      #${NAV_PANEL_ID} .ttnp-row--stack {
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
      }
      #${NAV_PANEL_ID} .ttnp-label {
        color: var(--twitch-tools-panel-muted, #b9b9c2);
      }
      #${NAV_PANEL_ID} .ttnp-value-group {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      #${NAV_PANEL_ID} .ttnp-value {
        font-weight: 800;
        color: var(--twitch-tools-accent, #9146ff);
      }
      #${NAV_PANEL_ID} .ttnp-icon-btn {
        display: inline-grid;
        place-items: center;
        width: 20px;
        height: 20px;
        border-radius: 6px;
        color: var(--twitch-tools-panel-muted, #8d8d97);
      }
      #${NAV_PANEL_ID} .ttnp-icon-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #ff6b81;
      }
      #${NAV_PANEL_ID} .ttnp-switch {
        position: relative;
        display: inline-flex;
        width: 38px;
        height: 22px;
        flex: 0 0 auto;
        cursor: pointer;
      }
      #${NAV_PANEL_ID} .ttnp-switch input {
        position: absolute;
        inset: 0;
        opacity: 0;
        cursor: pointer;
      }
      #${NAV_PANEL_ID} .ttnp-slider {
        position: relative;
        display: block;
        width: 100%;
        height: 100%;
        border-radius: 999px;
        border: 1px solid var(--twitch-tools-panel-border, rgba(255, 255, 255, 0.15));
        background: rgba(255, 255, 255, 0.08);
        transition: background-color 120ms ease, border-color 120ms ease;
      }
      #${NAV_PANEL_ID} .ttnp-slider::before {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        border-radius: 999px;
        background: #ffffff;
        transition: transform 120ms ease;
      }
      #${NAV_PANEL_ID} .ttnp-switch input:checked + .ttnp-slider {
        background: color-mix(in srgb, var(--twitch-tools-accent, #9146ff) 35%, transparent);
        border-color: var(--twitch-tools-accent, #9146ff);
      }
      #${NAV_PANEL_ID} .ttnp-switch input:checked + .ttnp-slider::before {
        transform: translateX(16px);
      }
      #${NAV_PANEL_ID} .ttnp-select {
        width: 100%;
        min-height: 32px;
        padding: 0 10px;
        border-radius: 8px;
        border: 1px solid var(--twitch-tools-panel-border, rgba(255, 255, 255, 0.12));
        background-color: var(--twitch-tools-panel-input-bg, #17171b);
      }
    `;
    document.documentElement.appendChild(style);
  };

  const SVG_NS = "http://www.w3.org/2000/svg";

  const createEl = (tag, options = {}, children = []) => {
    const node = document.createElement(tag);
    if (options.id) node.id = options.id;
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.attrs) {
      for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
    }
    for (const child of children) node.appendChild(child);
    return node;
  };

  const createTrashIcon = () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    const svgAttrs = {
      width: "12",
      height: "12",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true"
    };
    for (const [key, value] of Object.entries(svgAttrs)) svg.setAttribute(key, value);

    const parts = [
      ["polyline", { points: "3 6 5 6 21 6" }],
      ["path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }],
      ["path", { d: "M10 11v6" }],
      ["path", { d: "M14 11v6" }],
      ["path", { d: "M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }]
    ];
    for (const [tag, attrs] of parts) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      svg.appendChild(el);
    }
    return svg;
  };

  const buildNavPanelElement = () => {
    const arrow = createEl("div", { className: "ttnp-arrow" });

    const header = createEl("div", { className: "ttnp-header" }, [
      createEl("img", { className: "ttnp-logo", attrs: { alt: "", src: chrome.runtime.getURL("icons/icon32.png") } }),
      createEl("span", { className: "ttnp-title", text: "Twitch Auto Claim Plus" })
    ]);

    const pointsLabel = createEl("span", { className: "ttnp-label", text: "Points claimed" });

    const resetButton = createEl("button", {
      className: "ttnp-icon-btn",
      attrs: {
        type: "button",
        "data-action": "reset-points",
        title: "Reset points counter",
        "aria-label": "Reset points counter"
      }
    }, [createTrashIcon()]);

    const pointsRow = createEl("div", { className: "ttnp-row" }, [
      pointsLabel,
      createEl("span", { className: "ttnp-value-group" }, [
        createEl("strong", { id: "ttnp-points", className: "ttnp-value", text: "0" }),
        resetButton
      ])
    ]);

    const autoClaimSwitch = createEl("label", { className: "ttnp-switch" }, [
      createEl("input", { id: "ttnp-autoclaim", attrs: { type: "checkbox", "data-action": "toggle-autoclaim" } }),
      createEl("span", { className: "ttnp-slider" })
    ]);
    const autoClaimRow = createEl("div", { className: "ttnp-row" }, [
      createEl("span", { className: "ttnp-label", text: "Auto-claim" }),
      autoClaimSwitch
    ]);

    const themeSelect = createEl("select", { id: "ttnp-theme", className: "ttnp-select", attrs: { "data-action": "change-theme" } });
    for (const [key, preset] of Object.entries(THEME_PRESETS)) {
      const option = createEl("option", { text: preset.label, attrs: { value: key } });
      if (key === settings.theme) option.selected = true;
      themeSelect.appendChild(option);
    }
    const themeRow = createEl("div", { className: "ttnp-row ttnp-row--stack" }, [
      createEl("span", { className: "ttnp-label", text: "Theme" }),
      themeSelect
    ]);

    const panel = createEl("div", { id: NAV_PANEL_ID });
    panel.hidden = true;
    panel.append(arrow, header, pointsRow, autoClaimRow, themeRow);
    return panel;
  };

  const renderNavPanel = () => {
    const panel = document.getElementById(NAV_PANEL_ID);
    if (!panel) return;

    const pointsEl = panel.querySelector("#ttnp-points");
    const autoClaimEl = panel.querySelector("#ttnp-autoclaim");
    const themeEl = panel.querySelector("#ttnp-theme");

    if (pointsEl) {
      pointsEl.textContent = totalClaimedPoints > 0
        ? totalClaimedPoints.toLocaleString("en-US")
        : String(totalClaimedPoints || 0);
    }
    if (autoClaimEl) autoClaimEl.checked = Boolean(settings.autoClaim);
    if (themeEl && themeEl.value !== settings.theme) themeEl.value = settings.theme;
  };

  const positionNavPanel = () => {
    const button = document.getElementById(NAV_BUTTON_ID);
    const panel = document.getElementById(NAV_PANEL_ID);
    if (!button || !panel) return;

    const rect = button.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 260;

    // Anchor the panel's left edge near the button's left edge (nudged a few
    // px right so it reads as attached rather than centered under it).
    const desiredLeft = rect.left - 12;

    // Twitch's left side-nav rail (channel list, "For You", etc.) can extend
    // well past the button's own x-position. Keep the panel clear of it when
    // it's present, rather than letting it sit on top of that content.
    const sideNav = document.querySelector('[data-a-target="side-nav-bar"]');
    const sideNavRight = sideNav ? sideNav.getBoundingClientRect().right : 0;
    const minLeft = sideNavRight > 0 ? sideNavRight + 8 : 8;

    const left = Math.max(minLeft, Math.min(desiredLeft, window.innerWidth - panelWidth - 8));

    panel.style.top = `${Math.round(rect.bottom + 8)}px`;
    panel.style.left = `${Math.round(left)}px`;

    // The connector arrow always points at the button's true horizontal
    // center, independent of any clamping applied to the panel itself, so it
    // still looks correctly attached even when the panel gets nudged to stay
    // clear of the sidebar or the viewport edge.
    const arrow = panel.querySelector(".ttnp-arrow");
    if (arrow) {
      const buttonCenter = rect.left + rect.width / 2;
      const arrowLeft = Math.max(14, Math.min(buttonCenter - left - 6, panelWidth - 26));
      arrow.style.left = `${Math.round(arrowLeft)}px`;
    }
  };

  const closeNavPanel = () => {
    const panel = document.getElementById(NAV_PANEL_ID);
    if (panel) panel.hidden = true;
    navPanelOpen = false;
    document.removeEventListener("mousedown", onOutsideNavClick, true);
    document.removeEventListener("keydown", onNavPanelKeydown, true);
    window.removeEventListener("resize", positionNavPanel);
  };

  const onOutsideNavClick = (event) => {
    const panel = document.getElementById(NAV_PANEL_ID);
    const button = document.getElementById(NAV_BUTTON_ID);
    if (!panel) return;
    if (panel.contains(event.target) || button?.contains(event.target)) return;
    closeNavPanel();
  };

  const onNavPanelKeydown = (event) => {
    if (event.key === "Escape") closeNavPanel();
  };

  const createNavPanel = () => {
    if (document.getElementById(NAV_PANEL_ID)) return;
    injectNavStyle();

    const panel = buildNavPanelElement();

    panel.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target || target.dataset.action !== "reset-points") return;

      const confirmed = window.confirm("Reset the all-time points counter to 0? This can't be undone.");
      if (!confirmed) return;
      resetPointsTotal();
      renderNavPanel();
    });

    panel.addEventListener("change", (event) => {
      const target = event.target;
      const action = target?.dataset?.action;
      if (!action) return;

      if (action === "toggle-autoclaim") {
        const nextSettings = normalizeSettings({ ...settings, autoClaim: target.checked });
        safeStorageSet(nextSettings);
        applyRuntimeState(nextSettings);
      }

      if (action === "change-theme") {
        const selectedTheme = Object.prototype.hasOwnProperty.call(THEME_PRESETS, target.value)
          ? target.value
          : DEFAULTS.theme;
        const nextSettings = normalizeSettings({
          ...settings,
          theme: selectedTheme,
          themeEnabled: selectedTheme !== "default",
          accent: THEME_PRESETS[selectedTheme]?.accent || DEFAULTS.accent
        });
        safeStorageSet(nextSettings);
        applyRuntimeState(nextSettings);
      }
    });

    document.body.appendChild(panel);
  };

  const openNavPanel = () => {
    createNavPanel();
    renderNavPanel();

    const panel = document.getElementById(NAV_PANEL_ID);
    if (!panel) return;

    panel.hidden = false;
    positionNavPanel();
    navPanelOpen = true;

    document.addEventListener("mousedown", onOutsideNavClick, true);
    document.addEventListener("keydown", onNavPanelKeydown, true);
    window.addEventListener("resize", positionNavPanel);
  };

  const toggleNavPanel = () => {
    if (navPanelOpen) closeNavPanel();
    else openNavPanel();
  };

  const ensureNavButton = () => {
    if (document.getElementById(NAV_BUTTON_ID)) return;

    const ellipsis = document.querySelector(ELLIPSIS_SELECTOR);
    if (!ellipsis) return;

    const wrapper = ellipsis.closest("div") || ellipsis;
    if (!wrapper.parentElement) return;

    injectNavStyle();

    const button = document.createElement("button");
    button.id = NAV_BUTTON_ID;
    button.type = "button";
    button.title = "Twitch Auto Claim Plus";
    button.setAttribute("aria-label", "Twitch Auto Claim Plus");
    const icon = document.createElement("img");
    icon.alt = "";
    icon.src = chrome.runtime.getURL("icons/icon32.png");
    button.appendChild(icon);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNavPanel();
    });

    wrapper.parentElement.insertBefore(button, wrapper.nextSibling);
  };

  const applyTheme = () => {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.documentElement.appendChild(style);
    }

    document.documentElement.dataset.twitchToolsThemeEnabled = String(Boolean(settings.themeEnabled));
    document.documentElement.dataset.twitchToolsTheme = settings.theme;
    style.textContent = themeCss(settings);
  };

  const applyRuntimeState = (nextSettings, { runClaim = true } = {}) => {
    settings = normalizeSettings(nextSettings);
    applyTheme();
    renderNavPanel();
    if (runClaim) claimBonus();
  };

  const loadSettings = async () => {
    const [stored, localStored] = await Promise.all([
      safeStorageGet(DEFAULTS),
      safeLocalGet({ [CLAIM_SESSION_TOTAL_KEY]: 0 })
    ]);
    totalClaimedPoints = Number(localStored?.[CLAIM_SESSION_TOTAL_KEY]) || 0;
    safeStorageRemove(DEPRECATED_SETTINGS_KEYS);
    applyRuntimeState(stored, { runClaim: false });
  };

  const getStatus = () => ({
    isTwitch: /(^|\.)twitch\.tv$/i.test(location.hostname),
    autoClaimEnabled: Boolean(settings.autoClaim),
    themeEnabled: Boolean(settings.themeEnabled),
    theme: settings.theme,
    themeLabel: THEME_PRESETS[settings.theme]?.label || settings.theme,
    accent: settings.accent,
    fontScale: settings.fontScale,
    lastClaimAt,
    lastClaimAmount,
    lastClaimSource,
    totalClaimedPoints,
    visibleBonusButtons: isDashboardHost() ? 0 : candidateButtons().length
  });

  const startScanning = () => {
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = window.setInterval(() => {
      claimBonus();
      ensureNavButton();
    }, SCAN_INTERVAL_MS);

    ensureScanObserver();
    claimBonus();
    ensureNavButton();
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) return;

    if (message.type === "TWITCH_TOOLS_UPDATE") {
      const nextSettings = normalizeSettings({ ...settings, ...message.settings });
      safeStorageSet(nextSettings);
      applyRuntimeState(nextSettings);
      sendResponse({ ok: true, status: getStatus() });
      return;
    }

    if (message.type === "TWITCH_TOOLS_RESET_POINTS") {
      resetPointsTotal();
      renderNavPanel();
      sendResponse({ ok: true, status: getStatus() });
      return;
    }

    if (message.type === "TWITCH_TOOLS_GET_STATUS") {
      sendResponse({ ok: true, status: getStatus() });
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync") {
      let changed = false;
      const next = { ...settings };

      for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          next[key] = changes[key].newValue;
          changed = true;
        }
      }

      if (changed) {
        applyRuntimeState(next);
      }
      return;
    }

    if (areaName === "local" && Object.prototype.hasOwnProperty.call(changes, CLAIM_SESSION_TOTAL_KEY)) {
      // Keeps this tab's panel in sync even when the points total changed
      // elsewhere - another Twitch tab claiming a bonus, a reset triggered
      // from the popup/floating window, etc.
      const nextTotal = Number(changes[CLAIM_SESSION_TOTAL_KEY].newValue) || 0;
      if (nextTotal !== totalClaimedPoints) {
        totalClaimedPoints = nextTotal;
        renderNavPanel();
      }
    }
  });

  loadSettings().then(() => {
    startScanning();
  });

  window.addEventListener("pagehide", () => {
    if (scanTimer) window.clearInterval(scanTimer);
    if (queuedScan) window.clearTimeout(queuedScan);
    if (observer) observer.disconnect();
    closeNavPanel();
  });
})();

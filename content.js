(() => {
  "use strict";

  const THEME_PRESETS = {
    default: { label: "Twitch Default", accent: "#9146ff" },
    midnight: {
      label: "Midnight Blue",
      accent: "#63e6ff",
      bg: "#030817",
      base: "#071228",
      surface: "#0d1f3f",
      surface2: "#14345f",
      input: "#081733",
      text: "#f3f8ff",
      muted: "#9fb6d8",
      border: "#24466f",
      buttonText: "#001018"
    },
    slate: {
      label: "Slate Glass",
      accent: "#a78bfa",
      bg: "#111827",
      base: "#182131",
      surface: "#253247",
      surface2: "#334155",
      input: "#1f2937",
      text: "#f8fafc",
      muted: "#cbd5e1",
      border: "#475569",
      buttonText: "#0f172a"
    },
    cyber: {
      label: "Cyber Neon",
      accent: "#ff2bd6",
      bg: "#07000d",
      base: "#11001f",
      surface: "#230044",
      surface2: "#3a0872",
      input: "#1a0030",
      text: "#fff2ff",
      muted: "#dda6ff",
      border: "#7e22ce",
      buttonText: "#ffffff"
    },
    ember: {
      label: "Ember Red",
      accent: "#ff5a3d",
      bg: "#140504",
      base: "#210a06",
      surface: "#3a130c",
      surface2: "#5a2113",
      input: "#2b0e08",
      text: "#fff4ed",
      muted: "#f5b49c",
      border: "#7c331f",
      buttonText: "#ffffff"
    },
    forest: {
      label: "Forest Green",
      accent: "#39d98a",
      bg: "#031009",
      base: "#071a0f",
      surface: "#102a19",
      surface2: "#1d482b",
      input: "#0a2113",
      text: "#effff5",
      muted: "#a8dcb8",
      border: "#2f6f44",
      buttonText: "#001208"
    },
    arctic: {
      label: "Arctic Light",
      accent: "#2563eb",
      bg: "#edf6ff",
      base: "#f8fbff",
      surface: "#dcecff",
      surface2: "#c1dcff",
      input: "#ffffff",
      text: "#0b1220",
      muted: "#52657f",
      border: "#9bb7dc",
      buttonText: "#ffffff"
    },
    solar: {
      label: "Solar Gold",
      accent: "#f59e0b",
      bg: "#171006",
      base: "#241808",
      surface: "#3b270b",
      surface2: "#614012",
      input: "#2d1d08",
      text: "#fff7e2",
      muted: "#edc978",
      border: "#855d1a",
      buttonText: "#170d00"
    },
    rose: {
      label: "Rose Noir",
      accent: "#ff4d8d",
      bg: "#14040d",
      base: "#220817",
      surface: "#3a1029",
      surface2: "#5a1b42",
      input: "#2b0b1f",
      text: "#fff2f8",
      muted: "#f4a9cc",
      border: "#84345f",
      buttonText: "#ffffff"
    },
    ocean: {
      label: "Ocean Cyan",
      accent: "#00d4ff",
      bg: "#001018",
      base: "#021923",
      surface: "#062f42",
      surface2: "#0b4d68",
      input: "#042331",
      text: "#edfcff",
      muted: "#9de8f7",
      border: "#137190",
      buttonText: "#001018"
    },
    grape: {
      label: "Grape Pop",
      accent: "#c084fc",
      bg: "#10051d",
      base: "#1b0a30",
      surface: "#32135a",
      surface2: "#4c1d95",
      input: "#251044",
      text: "#fbf5ff",
      muted: "#d8b4fe",
      border: "#6d28d9",
      buttonText: "#ffffff"
    },
    matrix: {
      label: "Matrix Lime",
      accent: "#a3ff12",
      bg: "#020700",
      base: "#071000",
      surface: "#102400",
      surface2: "#1e3f05",
      input: "#0a1800",
      text: "#f4ffe8",
      muted: "#b9f48a",
      border: "#407012",
      buttonText: "#061000"
    },
    candy: {
      label: "Candy Light",
      accent: "#ec4899",
      bg: "#fff1f7",
      base: "#fff7fb",
      surface: "#ffd9ec",
      surface2: "#ffc1df",
      input: "#ffffff",
      text: "#2b1020",
      muted: "#7c3a58",
      border: "#f9a8d4",
      buttonText: "#ffffff"
    },
    oled: {
      label: "OLED Mint",
      accent: "#00ffcc",
      bg: "#000000",
      base: "#030303",
      surface: "#0b0b0b",
      surface2: "#171717",
      input: "#080808",
      text: "#f8f8f8",
      muted: "#b9b9b9",
      border: "#2a2a2a",
      buttonText: "#00130f"
    }
  };

  const DEFAULTS = {
    autoClaim: true,
    themeEnabled: false,
    theme: "default",
    accent: THEME_PRESETS.default.accent,
    fontScale: 100
  };

  const NATIVE_PALETTE = {
    text: "#efeff1",
    muted: "#adadb8",
    border: "#34343b",
    surface2: "#18181b",
    input: "#18181b",
    buttonText: "#ffffff"
  };

  const STYLE_ID = "twitch-tools-theme-style";
  const CLAIM_COOLDOWN_MS = 5000;
  const SCAN_INTERVAL_MS = 15000;
  const CLAIM_MUTATION_THROTTLE_MS = 2500;
  const SETTINGS_KEYS = Object.keys(DEFAULTS);
  const DEPRECATED_SETTINGS_KEYS = ["logoStyle","buttonStyle","buttonRadius","buttonGlow","tagStyle"];
  const CLAIM_SESSION_TOTAL_KEY = "twitchToolsClaimSessionTotal";

  let settings = { ...DEFAULTS };
  let lastClaimAt = 0;
  let lastClaimAmount = 0;
  let totalClaimedPoints = 0;
  let scanTimer = null;
  let observer = null;
  let observedRoot = null;
  let queuedScan = 0;

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
    });
  };

  const clampNumber = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  };

  const normalizeSettings = (raw) => {
    const next = { ...DEFAULTS, ...(raw || {}) };
    if (!Object.prototype.hasOwnProperty.call(THEME_PRESETS, next.theme)) next.theme = DEFAULTS.theme;

    next.autoClaim = Boolean(next.autoClaim);
    next.themeEnabled = Boolean(next.themeEnabled);
    next.accent = /^#[0-9a-f]{6}$/i.test(next.accent)
      ? next.accent
      : (THEME_PRESETS[next.theme]?.accent || DEFAULTS.accent);
    next.fontScale = clampNumber(next.fontScale, 90, 115, DEFAULTS.fontScale);
    return next;
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

  const claimBonus = () => {
    if (!settings.autoClaim) return;
    if (isDashboardHost()) return;
    if (Date.now() - lastClaimAt < CLAIM_COOLDOWN_MS) return;

    const button = candidateButtons()[0];
    if (!button) return;

    const amount = extractClaimAmount(button);
    lastClaimAt = Date.now();
    lastClaimAmount = amount;
    if (amount > 0) {
      totalClaimedPoints += amount;
      persistClaimSessionTotal(amount);
    }
    button.click();
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

  const interfaceCss = (_s, _p, accent, { includeAccentVars = true } = {}) => {
    return includeAccentVars ? accentCss(accent) : "";
  };

  const themeCss = (rawSettings) => {
    const s = normalizeSettings(rawSettings);
    const tuningCss = chatTuningCss(s);
    const activeTheme = Boolean(s.themeEnabled && s.theme !== "default");
    const p = activeTheme ? (THEME_PRESETS[s.theme] || THEME_PRESETS.midnight) : NATIVE_PALETTE;
    const accent = s.accent;
    const looseStyling = interfaceCss(s, p, accent, { includeAccentVars: !activeTheme });

    if (!activeTheme) return `${looseStyling}
${tuningCss}`;

    return `
      :root {
        --twitch-tools-accent: ${accent};
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

      input,
      textarea,
      select,
      [contenteditable="true"],
      [data-a-target="tw-input"] {
        color: ${p.text} !important;
        border-color: ${p.border} !important;
      }

      input,
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

      ${interfaceCss(s, p, accent, { includeAccentVars: false })}
      ${chatCss(p)}
      ${tuningCss}
    `;
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
    totalClaimedPoints,
    visibleBonusButtons: isDashboardHost() ? 0 : candidateButtons().length
  });

  const startScanning = () => {
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = window.setInterval(claimBonus, SCAN_INTERVAL_MS);

    ensureScanObserver();
    claimBonus();
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

    if (message.type === "TWITCH_TOOLS_GET_STATUS") {
      sendResponse({ ok: true, status: getStatus() });
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
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
  });

  loadSettings().then(() => {
    startScanning();
  });

  window.addEventListener("pagehide", () => {
    if (scanTimer) window.clearInterval(scanTimer);
    if (queuedScan) window.clearTimeout(queuedScan);
    if (observer) observer.disconnect();
  });
})();

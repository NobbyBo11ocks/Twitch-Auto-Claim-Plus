(() => {
  "use strict";

  const THEME_PRESETS = {
    default: "#9146ff",
    midnight: "#63e6ff",
    slate: "#a78bfa",
    cyber: "#ff2bd6",
    ember: "#ff5a3d",
    forest: "#39d98a",
    arctic: "#2563eb",
    solar: "#f59e0b",
    rose: "#ff4d8d",
    ocean: "#00d4ff",
    grape: "#c084fc",
    matrix: "#a3ff12",
    candy: "#ec4899",
    oled: "#00ffcc"
  };

  const PREVIEW_META = {
    default: { label: "Twitch default", desc: "Native Twitch styling." },
    midnight: { label: "Midnight Blue", desc: "Deep navy with cyan highlights." },
    slate: { label: "Slate Glass", desc: "Neutral graphite with violet accent." },
    cyber: { label: "Cyber Neon", desc: "Black-purple with magenta neon." },
    ember: { label: "Ember Red", desc: "Warm charcoal with orange-red glow." },
    forest: { label: "Forest Green", desc: "Dark green with mint highlights." },
    arctic: { label: "Arctic Light", desc: "Bright icy panels with blue accent." },
    solar: { label: "Solar Gold", desc: "Warm dark theme with amber accent." },
    rose: { label: "Rose Noir", desc: "Noir base with pink highlights." },
    ocean: { label: "Ocean Cyan", desc: "Deep ocean blue and bright cyan." },
    grape: { label: "Grape Pop", desc: "Purple panels with lavender accent." },
    matrix: { label: "Matrix Lime", desc: "Terminal black with lime green." },
    candy: { label: "Candy Light", desc: "Soft light theme with pink accent." },
    oled: { label: "OLED Mint", desc: "True black with mint accent." }
  };

  const DEFAULTS = {
    autoClaim: true,
    themeEnabled: false,
    theme: "default",
    accent: THEME_PRESETS.default,
    fontScale: 100
  };

  const DEPRECATED_SETTINGS_KEYS = ["logoStyle", "buttonStyle", "buttonRadius", "buttonGlow", "tagStyle"];
  const SETTINGS_KEYS = Object.keys(DEFAULTS);
  const $ = (id) => document.getElementById(id);

  const controls = {
    autoClaim: $("autoClaim"),
    themeEnabled: $("themeEnabled"),
    theme: $("theme"),
    accent: $("accent"),
    accentHex: $("accentHex"),
    fontScale: $("fontScale"),
    fontScaleValue: $("fontScaleValue"),
    presetAccent: $("presetAccent"),
    defaultAccent: $("defaultAccent"),
    resetAll: $("resetAll"),
    refreshStatus: $("refreshStatus"),
    status: $("status"),
    statusAutoClaim: $("statusAutoClaim"),
    statusTheme: $("statusTheme"),
    statusAccent: $("statusAccent"),
    statusLastClaim: $("statusLastClaim"),
    previewTitle: $("previewTitle"),
    previewDescription: $("previewDescription")
  };

  const missingControls = Object.entries(controls)
    .filter(([, element]) => !element)
    .map(([key]) => key);

  if (missingControls.length) {
    console.error("Twitch Auto Claim Plus popup missing controls:", missingControls.join(", "));
    return;
  }

  let currentSettings = { ...DEFAULTS };
  let isHydrating = true;
  let saveTimer = 0;
  let flashTimer = 0;
  let statusRequestInFlight = false;
  let relativeTimeTimer = 0;
  let lastRenderedStatusKey = "";
  let lastKnownStatus = null;

  const clearRuntimeError = () => {
    void chrome.runtime.lastError;
  };

  const clampNumber = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };

  const normaliseSettings = (settings = {}) => {
    const merged = { ...DEFAULTS, ...settings };
    const theme = Object.prototype.hasOwnProperty.call(THEME_PRESETS, merged.theme)
      ? merged.theme
      : DEFAULTS.theme;

    return {
      autoClaim: Boolean(merged.autoClaim),
      themeEnabled: Boolean(merged.themeEnabled),
      theme,
      accent: /^#[0-9a-f]{6}$/i.test(merged.accent)
        ? merged.accent
        : (THEME_PRESETS[theme] || DEFAULTS.accent),
      fontScale: clampNumber(merged.fontScale, 90, 115, DEFAULTS.fontScale)
    };
  };

  const setText = (element, value) => {
    if (element.textContent !== value) {
      element.textContent = value;
    }
  };

  const setAccentTheme = (accent) => {
    const nextAccent = (accent || DEFAULTS.accent).toUpperCase();
    document.documentElement.style.setProperty("--accent", nextAccent);
    setText(controls.accentHex, nextAccent);
  };

  const updatePreview = () => {
    const meta = PREVIEW_META[controls.theme.value] || PREVIEW_META.default;
    setText(controls.previewTitle, meta.label);
    setText(controls.previewDescription, meta.desc);
  };

  const updateDefaultAccentState = () => {
    controls.defaultAccent.checked =
      (controls.accent.value || "").toLowerCase() === DEFAULTS.accent.toLowerCase();
  };

  const setUi = (settings, { syncState = true } = {}) => {
    const next = normaliseSettings(settings);

    if (syncState) {
      currentSettings = next;
    }

    controls.autoClaim.checked = next.autoClaim;
    controls.themeEnabled.checked = next.themeEnabled;
    controls.theme.value = next.theme;
    controls.accent.value = next.accent;
    controls.fontScale.value = String(next.fontScale);
    setText(controls.fontScaleValue, `${next.fontScale}%`);
    setAccentTheme(next.accent);
    updateDefaultAccentState();
    updatePreview();
  };

  const flashStatus = (message) => {
    setText(controls.status, message);
    controls.status.classList.add("flash");
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      controls.status.classList.remove("flash");
      setText(controls.status, "Ready");
    }, 1600);
  };

  const formatRelativeTime = (timestamp) => {
    if (!timestamp) return "Never";

    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 5) return "Now";
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;

    return `${Math.floor(hours / 24)}d`;
  };

  const getActiveTwitchTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id && /^https:\/\/([a-z0-9-]+\.)*twitch\.tv\//i.test(tab.url || "") ? tab : null;
  };

  const buildOfflineStatus = () => ({
    online: false,
    autoClaim: "—",
    theme: "—",
    accent: "—",
    lastClaim: "—",
    lastClaimAt: 0
  });

  const buildStatusView = (payload, onTwitchTab) => {
    if (!onTwitchTab || !payload?.ok || !payload.status) {
      return buildOfflineStatus();
    }

    const status = payload.status;
    const accent = status.accent || controls.accent.value || DEFAULTS.accent;
    const themeLabel = status.themeEnabled
      ? (status.themeLabel || PREVIEW_META[status.theme]?.label || status.theme || "Custom")
      : "Default";

    return {
      online: true,
      autoClaim: status.autoClaimEnabled ? "On" : "Off",
      theme: themeLabel,
      accent: accent.toLowerCase() === DEFAULTS.accent.toLowerCase() ? "Default" : accent.toUpperCase(),
      lastClaim: formatRelativeTime(status.lastClaimAt),
      lastClaimAt: Number(status.lastClaimAt) || 0
    };
  };

  const renderStatusView = (view) => {
    const renderKey = JSON.stringify({
      autoClaim: view.autoClaim,
      theme: view.theme,
      accent: view.accent,
      lastClaim: view.lastClaim
    });

    lastKnownStatus = view;
    if (renderKey === lastRenderedStatusKey) {
      return;
    }

    lastRenderedStatusKey = renderKey;
    setText(controls.statusAutoClaim, view.autoClaim);
    setText(controls.statusTheme, view.theme);
    setText(controls.statusAccent, view.accent);
    setText(controls.statusLastClaim, view.lastClaim);
  };

  const refreshRelativeTimeOnly = () => {
    if (!lastKnownStatus?.online || !lastKnownStatus.lastClaimAt) {
      return;
    }

    const nextLastClaim = formatRelativeTime(lastKnownStatus.lastClaimAt);
    if (nextLastClaim === lastKnownStatus.lastClaim) {
      return;
    }

    renderStatusView({ ...lastKnownStatus, lastClaim: nextLastClaim });
  };

  const startRelativeTimeUpdates = () => {
    if (!relativeTimeTimer) {
      relativeTimeTimer = window.setInterval(refreshRelativeTimeOnly, 1000);
    }
  };

  const stopRelativeTimeUpdates = () => {
    if (relativeTimeTimer) {
      window.clearInterval(relativeTimeTimer);
      relativeTimeTimer = 0;
    }
  };

  const sendMessageToTab = async (tabId, message) => {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      clearRuntimeError();
      return null;
    }
  };

  const fetchStatus = async () => {
    if (statusRequestInFlight) {
      return null;
    }

    statusRequestInFlight = true;

    try {
      const tab = await getActiveTwitchTab();
      if (!tab) {
        renderStatusView(buildOfflineStatus());
        return null;
      }

      const response = await sendMessageToTab(tab.id, { type: "TWITCH_TOOLS_GET_STATUS" });
      renderStatusView(buildStatusView(response, true));
      return response;
    } finally {
      statusRequestInFlight = false;
    }
  };

  const applyToCurrentTab = async (settings) => {
    const tab = await getActiveTwitchTab();
    if (!tab) {
      renderStatusView(buildOfflineStatus());
      return null;
    }

    const response = await sendMessageToTab(tab.id, { type: "TWITCH_TOOLS_UPDATE", settings });
    renderStatusView(buildStatusView(response, true));
    return response;
  };

  const cleanupDeprecatedSettings = () => new Promise((resolve) => {
    chrome.storage.sync.remove(DEPRECATED_SETTINGS_KEYS, () => {
      clearRuntimeError();
      resolve();
    });
  });

  const saveSettings = (settings, message = "Saved") => {
    const next = normaliseSettings({ ...currentSettings, ...settings });
    currentSettings = next;

    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      await cleanupDeprecatedSettings();
      chrome.storage.sync.set(next, async () => {
        clearRuntimeError();
        await applyToCurrentTab(next);
        flashStatus(message);
      });
    }, 90);
  };

  const readUiSettings = () => normaliseSettings({
    ...currentSettings,
    autoClaim: controls.autoClaim.checked,
    themeEnabled: controls.themeEnabled.checked,
    theme: controls.theme.value,
    accent: controls.accent.value,
    fontScale: Number(controls.fontScale.value)
  });

  const applyDefaultAccent = () => {
    const next = normaliseSettings({ ...readUiSettings(), accent: DEFAULTS.accent });
    setUi(next);
    saveSettings(next, "Accent restored");
  };

  const applyPresetAccent = () => {
    const next = normaliseSettings({
      ...readUiSettings(),
      accent: THEME_PRESETS[controls.theme.value] || DEFAULTS.accent
    });
    setUi(next);
    saveSettings(next, "Accent preset set");
  };

  const setThemePreset = (theme) => {
    const selectedTheme = Object.prototype.hasOwnProperty.call(THEME_PRESETS, theme) ? theme : DEFAULTS.theme;
    const next = normaliseSettings({
      ...readUiSettings(),
      theme: selectedTheme,
      themeEnabled: selectedTheme !== "default",
      accent: THEME_PRESETS[selectedTheme] || DEFAULTS.accent
    });
    setUi(next);
    saveSettings(next, next.themeEnabled ? "Theme changed" : "Default restored");
  };

  const resetAllSettings = () => {
    setUi(DEFAULTS);
    saveSettings(DEFAULTS, "Everything reset");
  };

  const syncFromStorageChanges = (changes, areaName) => {
    if (areaName !== "sync" || isHydrating) {
      return;
    }

    const next = { ...currentSettings };
    let hasUpdates = false;

    for (const key of SETTINGS_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) {
        continue;
      }

      next[key] = changes[key].newValue;
      hasUpdates = true;
    }

    if (!hasUpdates) {
      return;
    }

    const synced = normaliseSettings(next);
    if (JSON.stringify(synced) === JSON.stringify(currentSettings)) {
      return;
    }

    currentSettings = synced;
    setUi(synced, { syncState: false });
  };

  const bindEvents = () => {
    controls.theme.addEventListener("change", () => setThemePreset(controls.theme.value));

    controls.themeEnabled.addEventListener("change", () => {
      const current = readUiSettings();
      const patch = controls.themeEnabled.checked
        ? (current.theme === "default"
            ? { themeEnabled: true, theme: "midnight", accent: THEME_PRESETS.midnight }
            : { themeEnabled: true })
        : { themeEnabled: false };

      const next = normaliseSettings({ ...current, ...patch });
      setUi(next);
      saveSettings(next, next.themeEnabled ? "Theme enabled" : "Theme disabled");
    });

    controls.autoClaim.addEventListener("change", () => saveSettings(readUiSettings(), "Saved"));

    controls.accent.addEventListener("input", () => {
      setAccentTheme(controls.accent.value);
      updateDefaultAccentState();
      saveSettings(readUiSettings(), "Accent changed");
    });

    controls.defaultAccent.addEventListener("change", () => {
      if (controls.defaultAccent.checked) {
        applyDefaultAccent();
      } else {
        updateDefaultAccentState();
        flashStatus("Pick a colour or preset");
      }
    });

    controls.fontScale.addEventListener("input", () => {
      setText(controls.fontScaleValue, `${controls.fontScale.value}%`);
      saveSettings(readUiSettings(), "Chat size updated");
    });

    controls.presetAccent.addEventListener("click", applyPresetAccent);
    controls.resetAll.addEventListener("click", resetAllSettings);
    controls.refreshStatus.addEventListener("click", fetchStatus);
    chrome.storage.onChanged.addListener(syncFromStorageChanges);
  };

  const initialise = async () => {
    bindEvents();
    await cleanupDeprecatedSettings();

    chrome.storage.sync.get(DEFAULTS, async (stored) => {
      clearRuntimeError();
      setUi(stored);
      isHydrating = false;
      startRelativeTimeUpdates();
      await fetchStatus();
    });

    window.addEventListener("beforeunload", () => {
      stopRelativeTimeUpdates();
      window.clearTimeout(saveTimer);
      window.clearTimeout(flashTimer);
      chrome.storage.onChanged.removeListener(syncFromStorageChanges);
    });
  };

  initialise();
})();
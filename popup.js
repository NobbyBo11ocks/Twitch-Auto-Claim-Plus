(() => {
  "use strict";

  const SETTINGS_KEYS = Object.keys(DEFAULTS);
  const CLAIM_SESSION_TOTAL_KEY = "twitchToolsClaimSessionTotal";
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
    statusTotalPoints: $("statusTotalPoints"),
    resetPoints: $("resetPoints"),
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

  const DEFAULT_PALETTE = {
    bg: "#0e0e10",
    bgSoft: "#17171b",
    bgHover: "#202028",
    border: "rgba(255, 255, 255, 0.08)",
    borderStrong: "rgba(255, 255, 255, 0.12)",
    text: "#f3f3f5",
    textSoft: "#b9b9c2",
    textDim: "#8d8d97"
  };

  const applyPopupPalette = (settings) => {
    const activeTheme = Boolean(settings.themeEnabled && settings.theme !== "default");
    const preset = activeTheme ? THEME_PRESETS[settings.theme] : null;

    const palette = preset
      ? {
          bg: preset.bg,
          bgSoft: preset.surface,
          bgHover: preset.surface2,
          border: preset.border,
          borderStrong: preset.border,
          text: preset.text,
          textSoft: preset.muted,
          textDim: preset.muted
        }
      : DEFAULT_PALETTE;

    const root = document.documentElement.style;
    root.setProperty("--bg", palette.bg);
    root.setProperty("--bg-soft", palette.bgSoft);
    root.setProperty("--bg-hover", palette.bgHover);
    root.setProperty("--border", palette.border);
    root.setProperty("--border-strong", palette.borderStrong);
    root.setProperty("--text", palette.text);
    root.setProperty("--text-soft", palette.textSoft);
    root.setProperty("--text-dim", palette.textDim);
  };

  const updatePreview = () => {
    const meta = THEME_PRESETS[controls.theme.value] || THEME_PRESETS.default;
    setText(controls.previewTitle, meta.label);
    setText(controls.previewDescription, meta.desc);
  };

  const updateDefaultAccentState = () => {
    controls.defaultAccent.checked =
      (controls.accent.value || "").toLowerCase() === DEFAULTS.accent.toLowerCase();
  };

  const setUi = (settings, { syncState = true } = {}) => {
    const next = normalizeSettings(settings);

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
    applyPopupPalette(next);
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

  const formatPoints = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number.toLocaleString("en-US") : "0";
  };

  // manifest.json's host_permissions/content_scripts use the "*://" match
  // pattern, which WebExtensions defines as http-or-https (never any other
  // scheme) - mirror that here instead of hardcoding https only, so this
  // check can't disagree with what the content script is actually allowed
  // to run on.
  const isTwitchUrl = (url) => /^https?:\/\/([a-z0-9-]+\.)*twitch\.tv\//i.test(url || "");

  const getActiveTwitchTab = async () => {
    // Don't scope this to "currentWindow": when running inside the popped-out
    // floating window (its own separate OS window, opened via
    // chrome.windows.create), "current window" is that floating window itself,
    // which only ever contains this extension's own popup.html tab - never the
    // actual Twitch tab, which lives in a different browser window entirely.
    const activeTabs = await chrome.tabs.query({ active: true });
    const twitchTabs = activeTabs.filter((tab) => tab?.id && isTwitchUrl(tab.url));

    if (!twitchTabs.length) return null;
    if (twitchTabs.length === 1) return twitchTabs[0];

    // Multiple windows each have their own active Twitch tab - prefer whichever
    // one is in the currently focused *normal* browser window (excluding our
    // own popup-type window, which is never the right answer here).
    const windows = await chrome.windows.getAll();
    const focusedNormal = windows.find((w) => w.focused && w.type === "normal");
    const preferred = focusedNormal && twitchTabs.find((tab) => tab.windowId === focusedNormal.id);
    return preferred || twitchTabs[0];
  };

  const buildOfflineStatus = () => ({
    online: false,
    autoClaim: "—",
    theme: "—",
    accent: "—",
    lastClaim: "—",
    lastClaimAt: 0,
    totalPoints: "—"
  });

  const buildStatusView = (payload, onTwitchTab) => {
    if (!onTwitchTab || !payload?.ok || !payload.status) {
      return buildOfflineStatus();
    }

    const status = payload.status;
    const accent = status.accent || controls.accent.value || DEFAULTS.accent;
    const themeLabel = status.themeEnabled
      ? (status.themeLabel || THEME_PRESETS[status.theme]?.label || status.theme || "Custom")
      : "Default";

    return {
      online: true,
      autoClaim: status.autoClaimEnabled ? "On" : "Off",
      theme: themeLabel,
      accent: accent.toLowerCase() === DEFAULTS.accent.toLowerCase() ? "Default" : accent.toUpperCase(),
      lastClaim: formatRelativeTime(status.lastClaimAt),
      lastClaimAt: Number(status.lastClaimAt) || 0,
      totalPoints: formatPoints(status.totalClaimedPoints)
    };
  };

  const renderStatusView = (view) => {
    const renderKey = JSON.stringify({
      autoClaim: view.autoClaim,
      theme: view.theme,
      accent: view.accent,
      lastClaim: view.lastClaim,
      totalPoints: view.totalPoints
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
    setText(controls.statusTotalPoints, view.totalPoints);
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

  const computeCenteredPosition = (width, height) => {
    const availWidth = window.screen.availWidth || window.screen.width || 1280;
    const availHeight = window.screen.availHeight || window.screen.height || 800;
    const availLeft = window.screen.availLeft || 0;
    const availTop = window.screen.availTop || 0;

    return {
      left: Math.round(availLeft + Math.max(0, (availWidth - width) / 2)),
      top: Math.round(availTop + Math.max(0, (availHeight - height) / 2))
    };
  };

  const openFloatingWindow = () => new Promise((resolve, reject) => {
    // The toolbar action popup itself can't be dragged or repositioned by any
    // extension API on any browser - that surface is entirely owned by the
    // browser chrome, and no browser lets an extension window drop its native
    // title bar either. Given that, this opens a real chrome.windows.create()
    // window (draggable, resizable, stays open) sized to the popup's natural
    // content dimensions - see fitFloatingWindowToContent() below, which
    // self-corrects the exact size once the new window has actually rendered.
    const width = FLOATING_WINDOW_WIDTH;
    const height = 522;
    const { left, top } = computeCenteredPosition(width, height);

    try {
      chrome.windows.create(
        {
          url: chrome.runtime.getURL("popup.html"),
          type: "popup",
          width,
          height,
          left,
          top
        },
        (win) => {
          clearRuntimeError();
          if (!win?.id) {
            reject(new Error("window creation did not return a window"));
            return;
          }
          resolve(win);
        }
      );
    } catch (error) {
      reject(error);
    }
  });

  // popup.css hardcodes html/body to exactly 388px wide (width/min-width/max-width
  // all 388px) - the content width never actually varies, so there's no need to
  // measure and fit it dynamically. A small buffer above that CSS floor absorbs
  // OS-level DPI-scaling rounding when chrome.windows.update() applies the
  // requested size (very common on Windows at 125%/150% scaling) - without it, a
  // resize can land a couple of pixels short of 388px and get permanently stuck
  // there, since this only runs once per window, forcing an unwanted horizontal
  // scrollbar on every theme/content change for the rest of that window's life.
  const FLOATING_WINDOW_WIDTH = 396;

  // Set only once boot() has confirmed windowType === "popup" - left null in
  // every other case (including the hand-off-failed fallback), so
  // fitFloatingWindowToContent() below can trust it as a safety gate without
  // re-querying chrome.windows.getCurrent() on every call. It fires often -
  // once at load, then again on every ResizeObserver-triggered re-fit as
  // themes/content change - and a window's own id/type never change during
  // its lifetime, so re-fetching every time was a pointless round-trip.
  let cachedFloatingWindowId = null;

  const fitFloatingWindowToContent = async () => {
    if (cachedFloatingWindowId === null) {
      return;
    }

    try {
      const app = document.querySelector(".app");
      if (!app) {
        return;
      }

      const rect = app.getBoundingClientRect();
      const chromeWidth = Math.max(0, window.outerWidth - window.innerWidth);
      const chromeHeight = Math.max(0, window.outerHeight - window.innerHeight);
      const targetWidth = Math.ceil(rect.width);
      const targetHeight = Math.ceil(rect.height);

      await chrome.windows.update(cachedFloatingWindowId, {
        width: targetWidth + chromeWidth,
        height: targetHeight + chromeHeight
      });

      // OS-level DPI scaling (125%/150%, common on Windows) can round the
      // requested size down by a couple of physical pixels. Measure what we
      // actually got rather than always padding the request - padding
      // unconditionally avoids the shortfall but leaves a permanent visible
      // gap of body background past .app's right edge on every system where
      // the rounding issue never happens, which is the common case. Only
      // nudge further if a real shortfall shows up.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const widthShortfall = targetWidth - window.innerWidth;
      if (widthShortfall > 0) {
        await chrome.windows.update(cachedFloatingWindowId, {
          width: targetWidth + chromeWidth + widthShortfall + 2
        });
      }
    } catch {
      // Best effort only - if window sizing APIs misbehave for any reason,
      // the window is still fully usable, just possibly not pixel-perfect.
    }
  };

  // The initial fit only captures whichever theme happens to be active the
  // moment the window opens. Switching themes afterward can change the
  // description text's wrapped line count (some descriptions are longer than
  // others), which changes .app's natural height without ever re-fitting the
  // window - the content then overflows the stale fixed height, triggering a
  // vertical scrollbar, which itself eats into the horizontal space and can
  // trigger a horizontal one too. A ResizeObserver re-fits on every actual
  // size change instead of only once, so this stays correct across every
  // theme rather than just whichever one loaded first.
  let contentResizeWatcherInstalled = false;
  const watchContentSizeForFloatingWindow = () => {
    if (contentResizeWatcherInstalled) {
      return;
    }

    const app = document.querySelector(".app");
    if (!app || typeof ResizeObserver === "undefined") {
      return;
    }

    contentResizeWatcherInstalled = true;
    let debounceTimer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => { fitFloatingWindowToContent(); }, 80);
    });
    observer.observe(app);
  };

  const resetPointsTotal = async () => {
    const tab = await getActiveTwitchTab();
    if (!tab) {
      flashStatus("Open a Twitch tab first");
      return;
    }

    const confirmed = window.confirm("Reset the all-time points counter to 0? This can't be undone.");
    if (!confirmed) {
      return;
    }

    const response = await sendMessageToTab(tab.id, { type: "TWITCH_TOOLS_RESET_POINTS" });
    renderStatusView(buildStatusView(response, true));
    flashStatus("Points counter reset");
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
    const next = normalizeSettings({ ...currentSettings, ...settings });
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

  const readUiSettings = () => normalizeSettings({
    ...currentSettings,
    autoClaim: controls.autoClaim.checked,
    themeEnabled: controls.themeEnabled.checked,
    theme: controls.theme.value,
    accent: controls.accent.value,
    fontScale: Number(controls.fontScale.value)
  });

  const applyDefaultAccent = () => {
    const next = normalizeSettings({ ...readUiSettings(), accent: DEFAULTS.accent });
    setUi(next);
    saveSettings(next, "Accent restored");
  };

  const applyPresetAccent = () => {
    const next = normalizeSettings({
      ...readUiSettings(),
      accent: THEME_PRESETS[controls.theme.value]?.accent || DEFAULTS.accent
    });
    setUi(next);
    saveSettings(next, "Accent preset set");
  };

  const setThemePreset = (theme) => {
    const selectedTheme = Object.prototype.hasOwnProperty.call(THEME_PRESETS, theme) ? theme : DEFAULTS.theme;
    const next = normalizeSettings({
      ...readUiSettings(),
      theme: selectedTheme,
      themeEnabled: selectedTheme !== "default",
      accent: THEME_PRESETS[selectedTheme]?.accent || DEFAULTS.accent
    });
    setUi(next);
    saveSettings(next, next.themeEnabled ? "Theme changed" : "Default restored");
  };

  const resetAllSettings = () => {
    setUi(DEFAULTS);
    saveSettings(DEFAULTS, "Everything reset");
  };

  const syncFromStorageChanges = (changes, areaName) => {
    if (areaName === "local") {
      // Points total changed elsewhere - another Twitch tab claiming, a claim
      // happening on the Twitch tab while this window just sits open, a reset
      // triggered from the overlay panel, etc. Refresh the whole status view
      // (not just the points number) so lastClaim stays consistent with it,
      // rather than showing a fresh total next to a stale claim time.
      if (Object.prototype.hasOwnProperty.call(changes, CLAIM_SESSION_TOTAL_KEY)) {
        fetchStatus();
      }
      return;
    }

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

    const synced = normalizeSettings(next);
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
            ? { themeEnabled: true, theme: "midnight", accent: THEME_PRESETS.midnight.accent }
            : { themeEnabled: true })
        : { themeEnabled: false };

      const next = normalizeSettings({ ...current, ...patch });
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
    controls.resetPoints.addEventListener("click", resetPointsTotal);
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
      requestAnimationFrame(() => {
        fitFloatingWindowToContent();
        watchContentSizeForFloatingWindow();
      });
    });

    window.addEventListener("beforeunload", () => {
      stopRelativeTimeUpdates();
      window.clearTimeout(saveTimer);
      window.clearTimeout(flashTimer);
      chrome.storage.onChanged.removeListener(syncFromStorageChanges);
    });
  };

  const boot = async () => {
    // Figure out whether this popup.html load is the anchored toolbar popup
    // or the already-floating window (our own chrome.windows.create() window,
    // type "popup"). If it's the anchored popup, hand off immediately instead
    // of rendering here - skip straight to opening the floating window and
    // closing this one, before doing any other setup work.
    let windowType = "normal";
    let currentWindowId = null;
    try {
      const win = await chrome.windows.getCurrent();
      windowType = win?.type || "normal";
      currentWindowId = win?.id ?? null;
    } catch {
      windowType = "normal";
    }

    if (windowType !== "popup") {
      try {
        await openFloatingWindow();
        window.close();
        return;
      } catch {
        // If the hand-off fails for any reason (window APIs unavailable,
        // creation rejected, etc.), fall back to rendering normally in place
        // rather than leaving a dead, blank popup with no way to recover.
        // windowType is still "normal" here, so cachedFloatingWindowId stays
        // null and fitFloatingWindowToContent() correctly stays a no-op -
        // this is the user's actual browser window, not ours to resize.
      }
    } else {
      cachedFloatingWindowId = currentWindowId;
    }

    await initialise();
  };

  boot();
})();
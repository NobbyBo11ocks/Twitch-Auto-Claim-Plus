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
    discordLink: $("discordLink"),
    sidenav: $("sidenav"),
    panels: $("panels"),
    status: $("status"),
    statusLastClaim: $("statusLastClaim"),
    statusTotalPoints: $("statusTotalPoints"),
    staleClaimWarning: $("staleClaimWarning"),
    resetPoints: $("resetPoints"),
    previewTitle: $("previewTitle"),
    previewDescription: $("previewDescription"),
    declutterOptions: $("declutterOptions"),
    declutterSelectAll: $("declutterSelectAll"),
    ignoredUserForm: $("ignoredUserForm"),
    ignoredUserInput: $("ignoredUserInput"),
    ignoredUsersList: $("ignoredUsersList"),
    ignoredUsersCount: $("ignoredUsersCount"),
    bulkAddIgnoredToggle: $("bulkAddIgnoredToggle"),
    bulkAddIgnoredPanel: $("bulkAddIgnoredPanel"),
    bulkAddIgnoredInput: $("bulkAddIgnoredInput"),
    bulkAddIgnoredSubmit: $("bulkAddIgnoredSubmit"),
    renamedUserForm: $("renamedUserForm"),
    renamedUserInput: $("renamedUserInput"),
    renamedNameInput: $("renamedNameInput"),
    renamedUsersList: $("renamedUsersList"),
    renamedUsersCount: $("renamedUsersCount"),
    bulkAddRenamedToggle: $("bulkAddRenamedToggle"),
    bulkAddRenamedPanel: $("bulkAddRenamedPanel"),
    bulkAddRenamedInput: $("bulkAddRenamedInput"),
    bulkAddRenamedSubmit: $("bulkAddRenamedSubmit"),
    exportSettings: $("exportSettings"),
    importSettingsButton: $("importSettingsButton"),
    importSettingsFile: $("importSettingsFile")
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

  // Built once (the option list is fixed, unlike the ignored/renamed-user
  // chip lists) - later updates only flip .checked via renderDeclutterState,
  // no need to tear down and rebuild the DOM on every settings change.
  let declutterGridBuilt = false;

  const buildDeclutterGrid = () => {
    if (declutterGridBuilt) return;
    declutterGridBuilt = true;

    for (const [id, option] of Object.entries(DECLUTTER_OPTIONS)) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.id = id;

      const label = document.createElement("label");
      label.className = "declutter-item";
      label.title = option.desc;
      label.append(input, document.createTextNode(option.label));

      controls.declutterOptions.appendChild(label);
    }
  };

  const renderDeclutterState = (hiddenElements) => {
    const hidden = new Set(hiddenElements);
    for (const input of controls.declutterOptions.querySelectorAll("input[type=\"checkbox\"]")) {
      input.checked = hidden.has(input.dataset.id);
    }
    const total = Object.keys(DECLUTTER_OPTIONS).length;
    controls.declutterSelectAll.checked = hidden.size === total;
    controls.declutterSelectAll.indeterminate = hidden.size > 0 && hidden.size < total;
  };

  const renderIgnoredUsers = (users) => {
    controls.ignoredUsersList.textContent = "";
    for (const name of users) {
      const item = document.createElement("li");
      item.className = "chip";

      const label = document.createElement("span");
      label.textContent = name;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "chip-remove";
      removeButton.dataset.username = name;
      removeButton.setAttribute("aria-label", `Stop ignoring ${name}`);
      removeButton.textContent = "×";

      item.append(label, removeButton);
      controls.ignoredUsersList.appendChild(item);
    }
  };

  const renderRenamedUsers = (renamedUsers) => {
    controls.renamedUsersList.textContent = "";
    for (const [name, customName] of Object.entries(renamedUsers)) {
      const item = document.createElement("li");
      item.className = "chip";

      const label = document.createElement("span");
      label.textContent = name;

      const arrow = document.createElement("span");
      arrow.className = "chip-arrow";
      arrow.textContent = "→";
      arrow.setAttribute("aria-hidden", "true");

      const customLabel = document.createElement("span");
      customLabel.textContent = customName;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "chip-remove";
      removeButton.dataset.username = name;
      removeButton.setAttribute("aria-label", `Remove custom name for ${name}`);
      removeButton.textContent = "×";

      item.append(label, arrow, customLabel, removeButton);
      controls.renamedUsersList.appendChild(item);
    }
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
    renderIgnoredUsers(next.ignoredUsers);
    renderRenamedUsers(next.renamedUsers);
    setText(controls.ignoredUsersCount, `${next.ignoredUsers.length}/${MAX_IGNORED_USERS}`);
    setText(controls.renamedUsersCount, `${Object.keys(next.renamedUsers).length}/${MAX_RENAMED_USERS}`);
    renderDeclutterState(next.hiddenElements);
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
    lastClaim: "—",
    lastClaimAt: 0,
    totalPoints: "—",
    staleClaimButtonWarning: false
  });

  const buildStatusView = (payload, onTwitchTab) => {
    if (!onTwitchTab || !payload?.ok || !payload.status) {
      return buildOfflineStatus();
    }

    const status = payload.status;

    return {
      online: true,
      lastClaim: formatRelativeTime(status.lastClaimAt),
      lastClaimAt: Number(status.lastClaimAt) || 0,
      totalPoints: formatPoints(status.totalClaimedPoints),
      staleClaimButtonWarning: Boolean(status.staleClaimButtonWarning)
    };
  };

  const renderStatusView = (view) => {
    const renderKey = JSON.stringify({
      lastClaim: view.lastClaim,
      totalPoints: view.totalPoints,
      staleClaimButtonWarning: view.staleClaimButtonWarning
    });

    lastKnownStatus = view;
    if (renderKey === lastRenderedStatusKey) {
      return;
    }

    lastRenderedStatusKey = renderKey;
    setText(controls.statusLastClaim, view.lastClaim);
    setText(controls.statusTotalPoints, view.totalPoints);
    controls.staleClaimWarning.hidden = !view.staleClaimButtonWarning;
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

  // Piggybacks a periodic full status refresh onto the existing 1s
  // relative-time tick rather than adding a second interval - this is what
  // lets the stale-claim-button warning (and anything else server-side that
  // doesn't have its own storage.onChanged signal) surface on its own while
  // the window is left open, instead of only ever updating on a manual
  // refresh click.
  let relativeTimeTickCount = 0;
  const FULL_STATUS_REFRESH_EVERY_N_TICKS = 20;

  const startRelativeTimeUpdates = () => {
    if (!relativeTimeTimer) {
      relativeTimeTimer = window.setInterval(() => {
        refreshRelativeTimeOnly();
        relativeTimeTickCount += 1;
        if (relativeTimeTickCount % FULL_STATUS_REFRESH_EVERY_N_TICKS === 0) {
          fetchStatus();
        }
      }, 1000);
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
    const height = 488;
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

  // popup.css hardcodes html/body to exactly 600px wide (width/min-width/max-width
  // all 600px) - the content width never actually varies, so there's no need to
  // measure and fit it dynamically. A small buffer above that CSS floor absorbs
  // OS-level DPI-scaling rounding when chrome.windows.update() applies the
  // requested size (very common on Windows at 125%/150% scaling) - without it, a
  // resize can land a couple of pixels short of 600px and get permanently stuck
  // there, since this only runs once per window, forcing an unwanted horizontal
  // scrollbar on every theme/content change for the rest of that window's life.
  const FLOATING_WINDOW_WIDTH = 608;

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
      const totalWidth = targetWidth + chromeWidth;
      const totalHeight = targetHeight + chromeHeight;

      // Re-centering here (not just resizing) matters now that the sidebar-tab
      // layout makes the window's height vary a lot by tab (Status is short,
      // Users can be tall with long chip lists) - anchoring only width/height
      // to a fixed top-left corner would let the window grow/shrink off-center
      // or even off-screen as the user switches tabs.
      const { left, top } = computeCenteredPosition(totalWidth, totalHeight);

      await chrome.windows.update(cachedFloatingWindowId, {
        width: totalWidth,
        height: totalHeight,
        left,
        top
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
        const adjustedWidth = totalWidth + widthShortfall + 2;
        const adjusted = computeCenteredPosition(adjustedWidth, totalHeight);
        await chrome.windows.update(cachedFloatingWindowId, {
          width: adjustedWidth,
          left: adjusted.left,
          top: adjusted.top
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
    const confirmed = window.confirm("Reset the points counter to 0? This can't be undone.");
    if (!confirmed) {
      return;
    }

    chrome.runtime.sendMessage({ type: "TWITCH_TOOLS_RESET_CLAIMS" }, async (response) => {
      clearRuntimeError();
      if (!response?.ok) {
        flashStatus("Reset failed");
        return;
      }
      await fetchStatus();
      flashStatus("Points counter reset");
    });
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
        const storageError = chrome.runtime.lastError;
        if (storageError) {
          // The UI is updated optimistically before the debounced write. If
          // sync storage rejects it (quota, policy, or a transient browser
          // error), restore the last persisted value instead of leaving the
          // controls showing settings that will disappear on reopen.
          chrome.storage.sync.get(DEFAULTS, (stored) => {
            clearRuntimeError();
            setUi(normalizeSettings(stored));
            flashStatus("Save failed - settings restored");
          });
          return;
        }
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

  const addIgnoredUser = (rawValue) => {
    const name = normalizeIgnoredUsername(rawValue);
    if (!name) return;

    if (!USERNAME_PATTERN.test(name)) {
      flashStatus("Not a valid Twitch username");
      return;
    }

    if (currentSettings.ignoredUsers.includes(name)) {
      controls.ignoredUserInput.value = "";
      flashStatus(`Already ignoring ${name}`);
      return;
    }

    const next = normalizeSettings({ ...currentSettings, ignoredUsers: [...currentSettings.ignoredUsers, name] });
    // normalizeSettings silently drops entries past MAX_IGNORED_USERS - if the
    // list didn't grow, that's what happened rather than the add succeeding.
    if (next.ignoredUsers.length === currentSettings.ignoredUsers.length) {
      flashStatus("Ignore list is full");
      return;
    }

    setUi(next);
    controls.ignoredUserInput.value = "";
    controls.ignoredUserInput.focus();
    saveSettings(next, `Ignoring ${name}`);
  };

  const removeIgnoredUser = (name) => {
    const nextList = currentSettings.ignoredUsers.filter((user) => user !== name);
    if (nextList.length === currentSettings.ignoredUsers.length) return;

    const next = normalizeSettings({ ...currentSettings, ignoredUsers: nextList });
    setUi(next);
    saveSettings(next, `Removed ${name}`);
  };

  // One line or comma-separated entry per username - independent entries, so
  // either separator (or a mix) works for a pasted list.
  const parseBulkUsernames = (raw) =>
    (raw || "")
      .split(/[\n,]+/)
      .map((entry) => normalizeIgnoredUsername(entry))
      .filter(Boolean);

  const addIgnoredUsersBulk = (raw) => {
    const candidates = parseBulkUsernames(raw);
    if (!candidates.length) {
      flashStatus("Nothing to add");
      return;
    }

    const existing = new Set(currentSettings.ignoredUsers);
    const toAdd = [];
    let invalid = 0;
    let duplicate = 0;

    for (const name of candidates) {
      if (!USERNAME_PATTERN.test(name)) {
        invalid += 1;
        continue;
      }
      if (existing.has(name) || toAdd.includes(name)) {
        duplicate += 1;
        continue;
      }
      toAdd.push(name);
    }

    if (!toAdd.length) {
      flashStatus(invalid && !duplicate ? "No valid usernames found" : "Already ignoring all of those");
      return;
    }

    const next = normalizeSettings({ ...currentSettings, ignoredUsers: [...currentSettings.ignoredUsers, ...toAdd] });
    const added = next.ignoredUsers.length - currentSettings.ignoredUsers.length;
    const skippedByCap = toAdd.length - added;

    setUi(next);
    controls.bulkAddIgnoredInput.value = "";

    const parts = [`Added ${added}`];
    if (duplicate) parts.push(`${duplicate} already ignored`);
    if (invalid) parts.push(`${invalid} invalid`);
    if (skippedByCap) parts.push(`${skippedByCap} over the limit`);
    saveSettings(next, parts.join(", "));
  };

  const addRenamedUser = (rawUsername, rawCustomName) => {
    const name = normalizeIgnoredUsername(rawUsername);
    if (!name) return;

    if (!USERNAME_PATTERN.test(name)) {
      flashStatus("Not a valid Twitch username");
      return;
    }

    const customName = normalizeCustomName(rawCustomName);
    if (!customName) {
      flashStatus("Enter a custom name");
      return;
    }

    const alreadyHadEntry = Object.prototype.hasOwnProperty.call(currentSettings.renamedUsers, name);
    const next = normalizeSettings({
      ...currentSettings,
      renamedUsers: { ...currentSettings.renamedUsers, [name]: customName }
    });

    // normalizeSettings silently drops entries past MAX_RENAMED_USERS - if this
    // is a brand new entry and the map didn't grow, that's what happened.
    if (!alreadyHadEntry && Object.keys(next.renamedUsers).length === Object.keys(currentSettings.renamedUsers).length) {
      flashStatus("Custom name list is full");
      return;
    }

    setUi(next);
    controls.renamedUserInput.value = "";
    controls.renamedNameInput.value = "";
    controls.renamedUserInput.focus();
    saveSettings(next, `Renamed ${name}`);
  };

  // One username=customName (or username,customName) pair per line - unlike
  // the ignore list's bulk parser, entries can't be comma-separated from each
  // other on one line, since a custom name is itself free text that may
  // contain a comma.
  const parseBulkRenamedEntries = (raw) =>
    (raw || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?)\s*[=,]\s*(.*)$/);
        return match ? [normalizeIgnoredUsername(match[1]), match[2]] : null;
      })
      .filter(Boolean);

  const addRenamedUsersBulk = (raw) => {
    const entries = parseBulkRenamedEntries(raw);
    if (!entries.length) {
      flashStatus("Nothing to add - use username = custom name, one per line");
      return;
    }

    const nextRenamedUsers = { ...currentSettings.renamedUsers };
    const originalCount = Object.keys(currentSettings.renamedUsers).length;
    let touched = 0;
    let invalid = 0;
    let emptyName = 0;

    for (const [name, rawCustomName] of entries) {
      if (!USERNAME_PATTERN.test(name)) {
        invalid += 1;
        continue;
      }
      const customName = normalizeCustomName(rawCustomName);
      if (!customName) {
        emptyName += 1;
        continue;
      }
      nextRenamedUsers[name] = customName;
      touched += 1;
    }

    if (!touched) {
      flashStatus("No valid entries found");
      return;
    }

    const next = normalizeSettings({ ...currentSettings, renamedUsers: nextRenamedUsers });
    const actuallyAdded = Object.keys(next.renamedUsers).length - originalCount;
    const skippedByCap = touched - actuallyAdded;

    setUi(next);
    controls.bulkAddRenamedInput.value = "";

    const parts = [`Saved ${touched} custom name${touched === 1 ? "" : "s"}`];
    if (invalid) parts.push(`${invalid} invalid username${invalid === 1 ? "" : "s"}`);
    if (emptyName) parts.push(`${emptyName} missing a name`);
    if (skippedByCap > 0) parts.push(`${skippedByCap} over the limit`);
    saveSettings(next, parts.join(", "));
  };

  const removeRenamedUser = (name) => {
    if (!Object.prototype.hasOwnProperty.call(currentSettings.renamedUsers, name)) return;

    const nextRenamedUsers = { ...currentSettings.renamedUsers };
    delete nextRenamedUsers[name];

    const next = normalizeSettings({ ...currentSettings, renamedUsers: nextRenamedUsers });
    setUi(next);
    saveSettings(next, `Removed custom name for ${name}`);
  };

  const SETTINGS_EXPORT_FILENAME = "twitch-auto-claim-plus-settings.json";

  const exportSettingsToFile = () => {
    const payload = {
      extension: "twitch-auto-claim-plus",
      exportedAt: new Date().toISOString(),
      settings: currentSettings
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = SETTINGS_EXPORT_FILENAME;
    document.body.appendChild(link);
    link.click();
    link.remove();

    // Revoke on a short delay rather than immediately after click() returns -
    // click() only starts the download, it doesn't wait for it, so revoking
    // synchronously risks the browser reading a already-dead blob URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    flashStatus("Settings exported");
  };

  const importSettingsFromFile = async (file) => {
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      // Accept either this extension's own export wrapper ({ settings: {...} })
      // or a bare settings object, so a hand-edited/hand-written file works too.
      const isPlainObject = (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value);
      const rawSettings = isPlainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "settings")
        ? parsed.settings
        : parsed;

      // JSON being syntactically valid is not enough: primitives, arrays,
      // and unrelated objects used to normalize to DEFAULTS and were then
      // reported as a successful import, effectively resetting everything.
      if (!isPlainObject(rawSettings) || !SETTINGS_KEYS.some((key) => Object.prototype.hasOwnProperty.call(rawSettings, key))) {
        throw new TypeError("Settings import does not contain recognized settings");
      }

      // normalizeSettings is the same defensive validation every other write
      // path in this file already goes through - reused here rather than
      // duplicated, since a file is arbitrary external input and needs exactly
      // the same clamping/shape checks a hand-typed setting would.
      const next = normalizeSettings(rawSettings);
      setUi(next);
      saveSettings(next, "Settings imported");
    } catch (error) {
      console.error("Twitch Auto Claim Plus: settings import failed", error);
      flashStatus("Import failed - not a valid settings file");
    }
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

  // The sidebar's five sections used to be two swapped full-height views
  // (mainView/settingsView). They're now permanent tabs sharing one wide,
  // short window - only the .panel matching the clicked .sidenav-item is
  // shown, and the footer's action icons stay visible in every tab.
  const TAB_IDS = ["status", "appearance", "declutter", "users", "backup"];

  const setActiveTab = (tabId) => {
    if (!TAB_IDS.includes(tabId)) return;

    controls.panels.querySelectorAll(".panel").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tabId;
    });

    controls.sidenav.querySelectorAll(".sidenav-item").forEach((item) => {
      if (item.dataset.tab === tabId) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });
  };

  const bindEvents = () => {
    buildDeclutterGrid();

    controls.declutterOptions.addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) return;

      const id = checkbox.dataset.id;
      const isHidden = currentSettings.hiddenElements.includes(id);
      const nextHiddenElements = checkbox.checked
        ? (isHidden ? currentSettings.hiddenElements : [...currentSettings.hiddenElements, id])
        : currentSettings.hiddenElements.filter((entry) => entry !== id);

      const next = normalizeSettings({ ...currentSettings, hiddenElements: nextHiddenElements });
      setUi(next);
      saveSettings(next, checkbox.checked ? `Hiding ${DECLUTTER_OPTIONS[id]?.label || id}` : "Saved");
    });

    controls.declutterSelectAll.addEventListener("change", () => {
      const hiddenElements = controls.declutterSelectAll.checked ? Object.keys(DECLUTTER_OPTIONS) : [];
      const next = normalizeSettings({ ...currentSettings, hiddenElements });
      setUi(next);
      saveSettings(next, controls.declutterSelectAll.checked ? "All clutter hidden" : "All clutter restored");
    });

    controls.sidenav.addEventListener("click", (event) => {
      const button = event.target.closest(".sidenav-item");
      if (!button) return;
      setActiveTab(button.dataset.tab);
    });

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

    controls.ignoredUserForm.addEventListener("submit", (event) => {
      event.preventDefault();
      addIgnoredUser(controls.ignoredUserInput.value);
    });

    controls.ignoredUsersList.addEventListener("click", (event) => {
      const target = event.target.closest(".chip-remove");
      if (!target) return;
      removeIgnoredUser(target.dataset.username);
    });

    controls.bulkAddIgnoredToggle.addEventListener("click", () => {
      const panel = controls.bulkAddIgnoredPanel;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) controls.bulkAddIgnoredInput.focus();
    });

    controls.bulkAddIgnoredSubmit.addEventListener("click", () => {
      addIgnoredUsersBulk(controls.bulkAddIgnoredInput.value);
    });

    controls.renamedUserForm.addEventListener("submit", (event) => {
      event.preventDefault();
      addRenamedUser(controls.renamedUserInput.value, controls.renamedNameInput.value);
    });

    controls.renamedUsersList.addEventListener("click", (event) => {
      const target = event.target.closest(".chip-remove");
      if (!target) return;
      removeRenamedUser(target.dataset.username);
    });

    controls.bulkAddRenamedToggle.addEventListener("click", () => {
      const panel = controls.bulkAddRenamedPanel;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) controls.bulkAddRenamedInput.focus();
    });

    controls.bulkAddRenamedSubmit.addEventListener("click", () => {
      addRenamedUsersBulk(controls.bulkAddRenamedInput.value);
    });

    controls.exportSettings.addEventListener("click", exportSettingsToFile);

    controls.importSettingsButton.addEventListener("click", () => controls.importSettingsFile.click());

    controls.importSettingsFile.addEventListener("change", async () => {
      const file = controls.importSettingsFile.files?.[0];
      controls.importSettingsFile.value = ""; // allow re-selecting the same file later
      await importSettingsFromFile(file);
    });

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

      // Opened via the in-page nav panel's gear icon (background.js appends
      // this query param to the window's URL) - jump straight to the
      // declutter tab (the old settings view's first section) instead of
      // landing on the status tab first.
      if (new URLSearchParams(window.location.search).get("view") === "settings") {
        setActiveTab("declutter");
      }

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

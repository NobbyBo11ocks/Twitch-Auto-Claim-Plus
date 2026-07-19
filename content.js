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
  let ignoredUsersSet = new Set();
  let renamedUsersMap = new Map();
  let lastClaimAt = 0;
  let totalClaimedPoints = 0;
  let scanTimer = null;
  let observer = null;
  let observedRoot = null;
  let queuedScan = 0;
  let navPanelOpen = false;
  let staleClaimButtonWarning = false;

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
    try {
      chrome.runtime.sendMessage({
        type: "TWITCH_TOOLS_RECORD_CLAIM",
        claim: { amount }
      }, (response) => {
        void chrome.runtime.lastError;
        if (!response?.ok) return;
        totalClaimedPoints = Number(response.total) || totalClaimedPoints;
        renderNavPanel();
      });
    } catch {
      // The visible claim still succeeded even if local accounting is
      // temporarily unavailable. Never retry the click just to fix history.
    }
  };

  const resetPointsTotal = () => {
    totalClaimedPoints = 0;
    try {
      chrome.runtime.sendMessage({ type: "TWITCH_TOOLS_RESET_CLAIMS" }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      safeLocalSet({ [CLAIM_SESSION_TOTAL_KEY]: 0 });
    }
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

  // Health-check for a broken selector/click path: if Twitch ever ships a
  // markup change that makes candidateButtons() find an element that looks
  // like a claim button but doesn't actually behave like one (or .click()
  // stops working against it for any reason), the normal symptom is that the
  // *same* DOM element keeps showing up as the top candidate on every scan
  // instead of disappearing once claimed. A real, working claim reliably
  // removes/replaces the button within one scan cycle, well under this
  // threshold - CANDIDATE_STALE_THRESHOLD_MS is set several multiples above
  // CLAIM_COOLDOWN_MS so ordinary claim latency can never trip it by itself.
  // Tagging the element itself (rather than tracking a selector string or
  // count) means a *different* bonus button appearing later is never
  // confused with the same stale one - only continuity of the exact element
  // counts.
  const CANDIDATE_SEEN_ATTR = "data-twitch-tools-first-seen";
  const CANDIDATE_STALE_THRESHOLD_MS = 45000;

  const updateStaleClaimButtonWarning = (button) => {
    if (!button || !settings.autoClaim) {
      staleClaimButtonWarning = false;
      return;
    }

    const now = Date.now();
    const seenAt = Number(button.getAttribute(CANDIDATE_SEEN_ATTR));
    if (!seenAt) {
      button.setAttribute(CANDIDATE_SEEN_ATTR, String(now));
      staleClaimButtonWarning = false;
      return;
    }

    staleClaimButtonWarning = now - seenAt > CANDIDATE_STALE_THRESHOLD_MS;
  };

  const claimBonus = () => {
    if (!settings.autoClaim) {
      staleClaimButtonWarning = false;
      return;
    }
    if (isDashboardHost()) {
      staleClaimButtonWarning = false;
      return;
    }
    if (Date.now() - lastClaimAt < CLAIM_COOLDOWN_MS) return;

    const button = candidateButtons()[0];
    updateStaleClaimButtonWarning(button);
    if (!button) return;

    lastClaimAt = Date.now();

    const textAmount = extractClaimAmount(button);
    // Only worth capturing this up-front if we'll actually need it - skip it
    // entirely on the fast path where the button's own text already gave us
    // a usable number.
    const previousPointsAddText = textAmount > 0 ? null : readPointsAddText();

    button.click();

    if (textAmount > 0) {
      totalClaimedPoints += textAmount;
      renderNavPanel();
      persistClaimSessionTotal(textAmount);
      return;
    }

    watchForPointsAdd(previousPointsAddText, (amount) => {
      if (amount === null) return; // Nothing usable found - leave the total untouched rather than guess.
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

  // Same row-level selector chatTuningCss already relies on for font scaling
  // (confirmed against a real capture from live Twitch, and independently
  // confirmed still current by BetterTTV's own open-source chat module,
  // which targets the same .chat-line__message class as of its current
  // master branch).
  //
  // .seventv-message is a second, unrelated row shape: when the 7TV
  // extension's own chat rendering is active it replaces Twitch's native
  // chat-line markup entirely with its own Vue-rendered tree (confirmed
  // directly from SevenTV/Extension's current source - src/site/twitch.tv/
  // modules/chat/ChatList.vue renders each message as
  // `<div class="seventv-message">`, not `.chat-line__message` at all), so a
  // 7TV user's messages need this selector too or they're invisible to
  // every query below regardless of what the ignore list contains.
  const CHAT_LINE_SELECTOR =
    '[data-a-target="chat-line-message"], [data-test-selector="chat-line-message"], .chat-line__message, .seventv-message';
  const IGNORED_LINE_ATTR = "data-twitch-tools-ignored";

  // .chat-author__display-name is what's always visible on native Twitch
  // chat; .chat-author__intl-login only renders (as "(login_name)") when the
  // display name uses a non-Latin script Twitch can't otherwise match a
  // typed-in login against - both read from real, currently-shipping Twitch
  // chat markup (same selectors this file already uses for username
  // styling, and confirmed still current via BetterTTV's chat module).
  //
  // .seventv-chat-user-username is 7TV's equivalent when its own chat
  // rendering replaces the row above - confirmed directly from
  // SevenTV/Extension's current source (src/app/chat/UserTag.vue): it holds
  // one <span> for the display name and, for non-Latin names, a second
  // <span>(login)</span> - same two-name shape as native Twitch, just
  // without dedicated per-part classes, so every child span is read and
  // stripped of any surrounding parens uniformly.
  const getChatLineAuthorCandidates = (line) => {
    const names = [];

    const displayEl = line.querySelector('[data-a-target="chat-message-username"], .chat-author__display-name');
    if (displayEl?.textContent) names.push(displayEl.textContent);

    // .trim() before stripping parens, not after - 7TV's intl-suffix span
    // (usertag.vue: `<span v-if="user.intl"> ({{ user.username }})</span>`)
    // renders with a leading space before the "(", so a bare /^\(/ never
    // matched it and the leading paren survived into the "normalized" name,
    // which then never validated as a real username (USERNAME_PATTERN has no
    // room for "("). Confirmed against SevenTV/Extension's current source.
    const loginEl = line.querySelector(".chat-author__intl-login");
    if (loginEl?.textContent) names.push(loginEl.textContent.trim().replace(/^\(|\)$/g, ""));

    for (const span of line.querySelectorAll(".seventv-chat-user-username span")) {
      if (span.textContent) names.push(span.textContent.trim().replace(/^\(|\)$/g, ""));
    }

    return names.map(normalizeIgnoredUsername).filter(Boolean);
  };

  // Fast path for ignore matching: once a line's canonical login has been
  // resolved (see resolveCanonicalLoginForLine below), check it directly
  // instead of re-reading the DOM. This matters once rename is involved -
  // applyRenameForLine can overwrite the native display node's text, so
  // re-deriving "who is this" from live text after that point would read our
  // own renamed text back instead of the real login. The multi-candidate
  // fallback below is kept as-is for lines whose login didn't resolve (or
  // for 7TV's nested-span markup, which is never mutated so reading it live
  // is always safe) - this can only ever match more than the fast path did,
  // never less, so it's not a behavior regression from before rename existed.
  const isIgnoredLine = (line, login) => {
    if (login && ignoredUsersSet.has(login)) return true;
    return ignoredUsersSet.size > 0 && getChatLineAuthorCandidates(line).some((name) => ignoredUsersSet.has(name));
  };

  // Toggles a plain inline style rather than removing the node from the DOM -
  // Twitch's own chat list is React-managed, and reparenting/removing a node
  // out from under React risks it throwing on its next reconciliation. Never
  // touching the node's identity, just its visibility, sidesteps that.
  const applyIgnoredLineVisibility = (line, ignored) => {
    if (ignored) {
      if (!line.hasAttribute(IGNORED_LINE_ATTR)) {
        line.setAttribute(IGNORED_LINE_ATTR, "true");
        line.style.display = "none";
      }
      return;
    }

    if (line.hasAttribute(IGNORED_LINE_ATTR)) {
      line.removeAttribute(IGNORED_LINE_ATTR);
      line.style.display = "";
    }
  };

  // The element actually holding the visible name text on native Twitch chat
  // (same selector getChatLineAuthorCandidates already uses) - a plain text
  // leaf with no child elements, safe to overwrite wholesale via textContent.
  const getChatLineNativeDisplayElement = (line) =>
    line.querySelector('[data-a-target="chat-message-username"], .chat-author__display-name');

  // Resolves a stable per-line "canonical login" once, then caches it on the
  // line's own dataset - every later scan of the same line (ignore-list
  // changes trigger a full-document rescan; see scanChatLinesForUserOverrides)
  // reads the cache instead of re-deriving from live text, which is what
  // keeps rename (a text mutation) from corrupting ignore-matching on the
  // same line afterward. Prefers .chat-author__intl-login when present - that
  // holds the real ASCII account login, which is what a user actually types
  // into the ignore/rename settings box, rather than a localized display name
  // that can't be typed back in to match it.
  const resolveCanonicalLoginForLine = (line) => {
    const cached = line.dataset.twitchToolsLogin;
    if (cached) return cached;

    const loginEl = line.querySelector(".chat-author__intl-login");
    const displayEl = getChatLineNativeDisplayElement(line);
    let login;

    if (loginEl || displayEl) {
      const raw = loginEl?.textContent?.trim().replace(/^\(|\)$/g, "") || displayEl?.textContent || "";
      login = normalizeIgnoredUsername(raw);
    } else {
      // 7TV rendering: getChatLineAuthorCandidates' first entry can be a
      // concatenated blob like "@Foo" or "Foo (login)" when a mention prefix
      // or intl suffix span is also present alongside the name (see that
      // function's own comments on usertag.vue's structure) - neither of
      // those is a real username, so prefer whichever candidate actually
      // looks like one (matches USERNAME_PATTERN) before falling back to
      // just taking the first. This matters for applyRenameForLine's
      // resolveNameTextNode lookup below, which needs an exact text match.
      const candidates = getChatLineAuthorCandidates(line);
      login = candidates.find((name) => USERNAME_PATTERN.test(name)) || candidates[0] || "";
    }

    if (login) line.dataset.twitchToolsLogin = login;
    return login;
  };

  // Shared by chat rename and channel-header rename: finds the one text node
  // inside `container` whose content actually is `normalizedLogin`, and
  // remembers the answer (including "not found") by object reference in a
  // WeakMap, so it's only ever walked once per container rather than
  // re-searched by content on every scan (which would break the moment the
  // text is renamed to something that no longer matches).
  //
  // The login check on first resolution matters wherever a container can
  // hold more than one candidate string - confirmed necessary from a live
  // capture on the channel header, where an <a href="/<login>"> wrapping a
  // "LIVE" status badge sits right next to the actual <a href="/<login>">
  // name link: without checking that the text is the login, both looked
  // identical to "some text inside a same-href link" and both got renamed,
  // turning the LIVE badge into a second copy of the custom name. The same
  // ambiguity exists in 7TV's chat markup, which packs an optional "@"
  // mention prefix and an optional "(login)" intl suffix as sibling text
  // nodes alongside the actual display name inside one wrapper (see
  // usertag.vue's structure) - this is what tells them apart safely.
  const resolvedNameTextNodes = new WeakMap();

  const resolveNameTextNode = (container, normalizedLogin) => {
    if (resolvedNameTextNodes.has(container)) return resolvedNameTextNodes.get(container);

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    let match = null;
    while ((node = walker.nextNode())) {
      const trimmed = node.textContent.trim();
      if (trimmed && normalizeIgnoredUsername(trimmed) === normalizedLogin) {
        match = node;
        break;
      }
    }

    resolvedNameTextNodes.set(container, match);
    return match;
  };

  // Caches each text node's pre-rename content the first time it's touched
  // (by object reference, not by re-reading the DOM) so a later removal of
  // the custom name can restore the real one instead of losing it.
  const originalTextByNode = new WeakMap();

  const applyNameToTextNode = (textNode, targetText) => {
    if (!textNode) return false;

    if (!originalTextByNode.has(textNode)) {
      originalTextByNode.set(textNode, textNode.textContent);
    }

    const text = targetText || originalTextByNode.get(textNode);
    if (text && textNode.textContent !== text) textNode.textContent = text;
    return true;
  };

  // Native Twitch chat's display element is a single-purpose leaf (nothing
  // else ever shares it), so no login-matching ambiguity exists there - the
  // first non-empty text node inside it is always the name, including for
  // non-Latin display names where it won't textually equal the login at all.
  const findFirstNonEmptyTextNode = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim()) return node;
    }
    return null;
  };

  // Covers both native Twitch chat and 7TV's own chat rendering (see
  // getChatLineNativeDisplayElement and the .seventv-chat-user-username
  // fallback below) - 7TV replaces Twitch's native chat-line markup
  // entirely when active, confirmed directly from SevenTV/Extension's
  // current source (src/app/chat/UserTag.vue), so relying on the native
  // selector alone would silently do nothing for anyone with 7TV installed.
  const applyRenameForLine = (line, login) => {
    if (!login) return;
    const customName = renamedUsersMap.get(login);

    const nativeDisplayEl = getChatLineNativeDisplayElement(line);
    if (nativeDisplayEl) {
      applyNameToTextNode(findFirstNonEmptyTextNode(nativeDisplayEl), customName);
      return;
    }

    const sevenTvNameEl = line.querySelector(".seventv-chat-user-username");
    if (sevenTvNameEl) {
      applyNameToTextNode(resolveNameTextNode(sevenTvNameEl, login), customName);
    }
  };

  // applyRenameForLine above only ever touches the author name at the start
  // of a line - it never looks at the message *body*, so an @mention of a
  // renamed user appearing inside someone's message text (including the
  // sender's own message, right after rewriteChatInputMentions below swaps
  // their typed custom name for the real login before sending) still showed
  // the real login once rendered, not the custom name. This is the mirror
  // image of that send-time rewrite: real login -> custom name, applied only
  // for display, on the message body specifically. Selectors reused from
  // chatTuningCss below (chat-message-text/chat-line-message-body), already
  // relied on elsewhere in this file for the same message-body region.
  //
  // .seventv-chat-message-body is 7TV's equivalent when its own chat
  // rendering is active - confirmed directly from SevenTV/Extension's
  // current source (src/app/chat/UserMessage.vue: the message body is a
  // `<span class="seventv-chat-message-body">`, a sibling of UserTag rather
  // than nested inside it). Without this, a 7TV user's message text was never
  // matched here at all - only the native-Twitch selectors were - so an
  // @mention of a renamed user inside a 7TV-rendered message silently kept
  // showing the real login instead of the custom name, the exact gap
  // getChatLineAuthorCandidates/applyRenameForLine already closed for the
  // author name itself.
  const CHAT_MESSAGE_BODY_SELECTOR =
    '[data-a-target="chat-message-text"], [data-test-selector="chat-message-text"], [data-a-target="chat-line-message-body"], [data-test-selector="chat-line-message-body"], .seventv-chat-message-body';

  // Caches each message-body text node's original content the first time
  // it's seen (same idea as originalTextByNode, kept separate since a
  // message body can contain several independently-matched mentions per
  // node, not just one whole-node name).
  const originalMessageTextByNode = new WeakMap();

  // No filtering by whether the custom name contains whitespace here (unlike
  // buildMentionRewritePairs for the input box) - a real login can never
  // contain a space, so matching "@reallogin" is always unambiguous
  // regardless of what the display-only replacement text looks like.
  const buildDisplayMentionPairs = () =>
    [...renamedUsersMap.entries()].sort((a, b) => b[0].length - a[0].length);

  // This TreeWalks every text node of a chat line's entire message body -
  // meaningfully more expensive than the author-name-only work elsewhere in
  // this file - and runs once per new chat message via the mutation observer
  // below, so it's worth skipping outright on the common install that has
  // never configured a custom name at all. Gating on renamedUsersMap.size
  // alone would be wrong though: if a line's message body was previously
  // rewritten (someone's only remaining custom name just got removed),
  // skipping here would leave that body stuck showing the custom name
  // forever instead of reverting to the real login. A per-line dataset flag
  // (set only when a rewrite actually took effect on this line, cleared once
  // its own revert pass completes) distinguishes "never touched, nothing to
  // do" from "was touched, still needs one more pass" - same idea as
  // channelHeaderRenameEverApplied/sideNavRenameEverApplied above, just
  // scoped per line instead of per page.
  // Same marker-attribute idiom as IGNORED_LINE_ATTR above (set/checked/
  // cleared via setAttribute/hasAttribute/removeAttribute), not the
  // dataset-caching idiom resolveCanonicalLoginForLine uses - this one is a
  // plain boolean flag, not a cached value.
  const MENTION_APPLIED_ATTR = "data-twitch-tools-mention-applied";

  const applyMentionRenamesForLine = (line) => {
    if (renamedUsersMap.size === 0 && !line.hasAttribute(MENTION_APPLIED_ATTR)) return;

    const pairs = buildDisplayMentionPairs();
    let appliedAny = false;

    for (const body of line.querySelectorAll(CHAT_MESSAGE_BODY_SELECTOR)) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!originalMessageTextByNode.has(node)) {
          originalMessageTextByNode.set(node, node.textContent);
        }

        const original = originalMessageTextByNode.get(node);
        if (!original.includes("@")) continue;

        let text = original;
        for (const [login, customName] of pairs) {
          const pattern = new RegExp(`(^|\\s)@${escapeRegExp(login)}(?=$|[^A-Za-z0-9_])`, "gi");
          text = text.replace(pattern, (_match, prefix) => `${prefix}@${customName}`);
        }

        if (text !== original) appliedAny = true;
        if (node.textContent !== text) node.textContent = text;
      }
    }

    if (appliedAny) line.setAttribute(MENTION_APPLIED_ATTR, "true");
    else line.removeAttribute(MENTION_APPLIED_ATTR);
  };

  // Anchor for the nickname pencil icon - the whole clickable name element,
  // present in both native Twitch chat and 7TV's rendering. Only ever
  // appended next to as a new sibling, never mutating this element itself.
  const getChatLineAuthorAnchor = (line) =>
    line.querySelector(
      '[data-a-target="chat-message-username"], .chat-author__display-name, .seventv-chat-user-username'
    );

  const NICKNAME_BUTTON_CLASS = "twitch-tools-nickname-btn";

  const createPencilIcon = () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    const svgAttrs = {
      width: "10",
      height: "10",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true"
    };
    for (const [key, value] of Object.entries(svgAttrs)) svg.setAttribute(key, value);

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z");
    svg.appendChild(path);
    return svg;
  };

  // Opens a plain native prompt() rather than a custom popover - this mirrors
  // BetterTTV's own long-shipped nicknames feature (chat_nicknames /
  // chat_moderator_cards modules), which uses the same prompt()-based flow
  // triggered from a pencil icon next to the chat username. Settings are
  // written straight to chrome.storage.sync so the popup's "Custom names"
  // list (settings-schema.js normalizeRenamedUsers) and this in-chat shortcut
  // always agree on the same underlying data.
  const promptForNickname = (login) => {
    const current = renamedUsersMap.get(login) || "";
    const input = window.prompt(`Custom display name for ${login} (leave blank to remove):`, current);
    if (input === null) return;

    const trimmed = normalizeCustomName(input);
    const nextRenamed = { ...settings.renamedUsers };
    if (trimmed) {
      nextRenamed[login] = trimmed;
    } else {
      delete nextRenamed[login];
    }

    const nextSettings = normalizeSettings({ ...settings, renamedUsers: nextRenamed });
    safeStorageSet(nextSettings);
    applyRuntimeState(nextSettings);
  };

  const ensureNicknameButton = (line, login) => {
    if (!login) return;
    const anchor = getChatLineAuthorAnchor(line);
    if (!anchor || !anchor.parentElement) return;
    if (anchor.nextElementSibling?.classList?.contains(NICKNAME_BUTTON_CLASS)) return;

    // Chat can render before ensureNavButton() has had a chance to run (it
    // depends on Twitch's top-nav ellipsis button existing first), so this
    // can't rely on that call path alone to have injected the stylesheet
    // defining this button's appearance - do it here too (idempotent, see
    // the guard at the top of injectNavStyle).
    injectNavStyle();

    const button = document.createElement("button");
    button.type = "button";
    button.className = NICKNAME_BUTTON_CLASS;
    button.title = "Set a custom display name";
    button.setAttribute("aria-label", `Set a custom display name for ${login}`);
    button.dataset.login = login;
    button.appendChild(createPencilIcon());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      promptForNickname(login);
    });

    anchor.parentElement.insertBefore(button, anchor.nextSibling);
  };

  // root defaults to the whole document (used after the ignore/rename lists
  // themselves change, so previously-hidden lines that no longer match get
  // revealed again, and renamed/reverted lines pick up the change) but is
  // scoped to just-added nodes from the mutation observer's hot path below,
  // so ordinary chat traffic doesn't pay for a full-document query on every
  // message.
  // This whole feature set is cosmetic - it must never be able to take down
  // auto-claim (the extension's core job) just because one chat row has an
  // unexpected shape on some Twitch UI variant or third-party chat extension.
  // Every line is handled independently (one bad row can't abort the rest of
  // the batch) and the whole scan is called from its call sites wrapped so a
  // failure here can't propagate up into applyRuntimeState and block
  // claimBonus() from ever running.
  const scanChatLinesForUserOverrides = (root) => {
    const scope = root || document;
    const lines = scope.matches?.(CHAT_LINE_SELECTOR)
      ? [scope, ...scope.querySelectorAll(CHAT_LINE_SELECTOR)]
      : Array.from(scope.querySelectorAll?.(CHAT_LINE_SELECTOR) || []);
    for (const line of lines) {
      try {
        const login = resolveCanonicalLoginForLine(line);
        applyIgnoredLineVisibility(line, isIgnoredLine(line, login));
        applyRenameForLine(line, login);
        applyMentionRenamesForLine(line);
        ensureNicknameButton(line, login);
      } catch (error) {
        console.error("Twitch Auto Claim Plus: failed to evaluate a chat line for ignore/rename", error);
      }
    }
  };

  const safeScanChatLinesForUserOverrides = (root) => {
    try {
      scanChatLinesForUserOverrides(root);
    } catch (error) {
      console.error("Twitch Auto Claim Plus: ignore/rename chat scan failed", error);
    }
  };

  // The broadcaster's name in their own channel header/title area has no
  // stable class-based hook - unlike chat, which stays on documented
  // data-a-target/BEM classes (see getChatLineAuthorCandidates above),
  // Twitch's channel header uses hashed styled-components classes that
  // change on every frontend deploy. Confirmed via FrankerFaceZ's own
  // current source (src/sites/twitch-twilight/modules/channel.jsx): even
  // FFZ, a much larger and longer-running project, has to walk React fiber
  // internals to reliably read the stream title rather than use a plain CSS
  // selector, because no such stable selector exists for that text.
  //
  // Rather than that fragile React-internals approach, this keys off the
  // broadcaster's own profile link instead: Twitch always renders the name
  // as an <a href="/<login>"> somewhere in the page chrome (it has to, for
  // navigation to work), and that href is derived straight from the same
  // channel data as the display name - far more stable than any hashed class
  // name. Several tight scopes are tried first, in order:
  //   - [data-a-target="channel-header"] and #live-channel-stream-information
  //     (FFZ's own confirmed hook for this info bar)
  //   - .metadata-layout__support - a real, human-authored BEM class (not one
  //     of Twitch's hashed styled-components classes like "Layout-sc-...")
  //     confirmed present directly from the user's own DevTools capture on a
  //     live channel page, one ancestor level above the name link
  // If Twitch's markup matches none of those (page layout varies, or shifts
  // over time), this falls back to scanning the whole page rather than
  // silently doing nothing - excluded from that fallback is the chat
  // scroller, which already has its own rename handling with different
  // matching rules (e.g. intl-login preference) in
  // scanChatLinesForUserOverrides, so the two can't fight over the same node.
  // Note the whole-document fallback is materially more expensive per scan
  // than a tight container match - it's what was actually engaging during
  // testing (confirmed by the fact a same-href "LIVE" status badge got
  // renamed too, which required a container broad enough to hold both that
  // badge and the real name link), which is exactly what the
  // .metadata-layout__support entry above is meant to head off going
  // forward.
  const CHANNEL_HEADER_CONTAINER_SELECTORS = [
    '[data-a-target="channel-header"]',
    "#live-channel-stream-information",
    ".metadata-layout__support"
  ];

  // Tracks whether the current channel page has ever had a rename applied,
  // so the (more expensive) whole-document fallback scan only ever runs
  // while there's actually something to do for the channel being viewed -
  // either applying a configured custom name, or reverting one that was just
  // removed - rather than on every mutation/interval tick for every visitor
  // who hasn't configured this feature at all.
  let lastChannelHeaderLogin = "";
  let channelHeaderRenameEverApplied = false;

  const applyChannelHeaderRename = () => {
    const rawLogin = (location.pathname.split("/")[1] || "").split(/[?#]/)[0];
    if (!rawLogin) return;

    if (rawLogin !== lastChannelHeaderLogin) {
      lastChannelHeaderLogin = rawLogin;
      channelHeaderRenameEverApplied = false;
    }

    const normalizedLogin = normalizeIgnoredUsername(rawLogin);
    const customName = renamedUsersMap.get(normalizedLogin);
    if (!customName && !channelHeaderRenameEverApplied) return;

    let containers = CHANNEL_HEADER_CONTAINER_SELECTORS
      .map((selector) => document.querySelector(selector))
      .filter(Boolean);
    if (!containers.length) containers = [document.body];

    const chatScroller = document.querySelector('[data-a-target="chat-scroller"]');
    const loginLower = rawLogin.toLowerCase();
    let appliedAny = false;

    for (const container of containers) {
      for (const link of container.querySelectorAll("a[href]")) {
        if (chatScroller && chatScroller.contains(link)) continue;

        const href = link.getAttribute("href") || "";
        const path = href.replace(/^https?:\/\/(www\.)?twitch\.tv/i, "").split(/[?#]/)[0];
        if (path.toLowerCase() !== `/${loginLower}`) continue;

        if (applyNameToTextNode(resolveNameTextNode(link, normalizedLogin), customName)) appliedAny = true;
      }
    }

    if (customName && appliedAny) {
      channelHeaderRenameEverApplied = true;
    } else if (!customName) {
      // The revert pass this call just ran (we only got here because the
      // flag was true) is done - clear it so future calls go back to the
      // cheap early-return above instead of re-scanning forever for the
      // rest of this tab's session just because the feature was used once.
      channelHeaderRenameEverApplied = false;
    }
  };

  const safeApplyChannelHeaderRename = () => {
    try {
      applyChannelHeaderRename();
    } catch (error) {
      console.error("Twitch Auto Claim Plus: channel header rename failed", error);
    }
  };

  // The left rail (Followed/Recommended/Live channels) is a different case
  // from the channel header above: it lists many *other* channels at once,
  // not just the one currently being viewed, so this checks every entry's
  // link against the whole renamedUsersMap instead of a single expected
  // login. [data-a-target="side-nav-bar"] is already relied on elsewhere in
  // this file (positionNavPanel, to keep the nav panel clear of this same
  // rail), so it's a selector this codebase already trusts, not a fresh
  // guess.
  const SIDE_NAV_SELECTOR = '[data-a-target="side-nav-bar"]';
  const SIDE_NAV_LINK_LOGIN_PATTERN = /^\/([a-z0-9_]{4,25})\/?$/i;

  // Same "has this ever actually applied a rename" tracking as
  // channelHeaderRenameEverApplied above, for the same reason: without it,
  // removing someone's *last* remaining custom name would make
  // renamedUsersMap.size drop to 0, which would hit the early-return below
  // and skip the scan entirely - leaving that sidebar entry stuck showing
  // the old custom name forever instead of reverting to their real name.
  let sideNavRenameEverApplied = false;

  const applySideNavRenames = () => {
    if (renamedUsersMap.size === 0 && !sideNavRenameEverApplied) return;

    const sideNav = document.querySelector(SIDE_NAV_SELECTOR);
    if (!sideNav) return;

    for (const link of sideNav.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") || "";
      const path = href.replace(/^https?:\/\/(www\.)?twitch\.tv/i, "").split(/[?#]/)[0];
      const match = SIDE_NAV_LINK_LOGIN_PATTERN.exec(path);
      if (!match) continue;

      const normalizedLogin = normalizeIgnoredUsername(match[1]);
      const customName = renamedUsersMap.get(normalizedLogin);
      if (applyNameToTextNode(resolveNameTextNode(link, normalizedLogin), customName) && customName) {
        sideNavRenameEverApplied = true;
      }
    }

    // The revert pass just ran across every entry (we only got here because
    // the flag was true with no custom names left) - clear it so future
    // calls go back to the cheap early-return above instead of re-scanning
    // the whole rail forever for the rest of this tab's session just
    // because the feature was used once.
    if (renamedUsersMap.size === 0) sideNavRenameEverApplied = false;
  };

  const safeApplySideNavRenames = () => {
    try {
      applySideNavRenames();
    } catch (error) {
      console.error("Twitch Auto Claim Plus: side nav rename failed", error);
    }
  };

  // Lets a message actually @-mention someone using their custom name -
  // typing "@FrenchGuy" rewrites to "@karmahds" right before the message
  // sends, so Twitch's own mention highlighting/notification (which only
  // recognizes real logins) still works correctly for the real account.
  //
  // BetterTTV's own equivalent (src/modules/send_message/index.js, confirmed
  // directly from their current source) does this by walking React fiber
  // internals to find Twitch's chat controller component and monkey-patching
  // its sendMessage method directly - deliberately not used here. That
  // technique breaks the moment Twitch restructures that part of the React
  // tree, and unlike every other cosmetic fix in this file, a failure there
  // risks the ability to send *any* chat message at all, not just a display
  // glitch. This instead uses a plain, well-established browser-extension
  // pattern for intercepting a page's own input handling: a capture-phase
  // listener on the document catches the Enter keydown (or a click anywhere
  // in the send form, covering an on-screen send button) before it reaches
  // Twitch's own React event handling, rewrites the input's text nodes in
  // place (never touching non-text children like an inline emote image the
  // picker may have inserted), and fires a real InputEvent so Twitch's
  // controlled input re-syncs its own state to the rewritten text before
  // that same keydown/click continues on to Twitch's send logic.
  const CHAT_SEND_FORM_SELECTOR = 'form[data-a-target="chat-send-message-form"]';
  const CHAT_INPUT_CONTAINER_SELECTOR = '[data-a-target="chat-input"], [data-test-selector="chat-input"]';

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Multi-word custom names ("French Guy") can never be typed as a single
  // "@word" mention token anyway - Twitch's own mentions don't span spaces
  // either - so those are simply not offered for rewriting here rather than
  // silently doing a partial, broken match. Sorted longest-first so a short
  // custom name that happens to be a prefix of a longer one ("Guy" vs
  // "GuyTwo") can't shadow the longer, more specific match.
  const buildMentionRewritePairs = () =>
    [...renamedUsersMap.entries()]
      .filter(([, customName]) => !/\s/.test(customName))
      .sort((a, b) => b[1].length - a[1].length);

  const rewriteChatInputMentions = (editable) => {
    const pairs = buildMentionRewritePairs();
    if (!pairs.length) return;

    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let node;
    let changed = false;
    while ((node = walker.nextNode())) {
      const original = node.textContent;
      if (!original || !original.includes("@")) continue;

      let text = original;
      for (const [login, customName] of pairs) {
        // Requires the "@" to actually start a mention - either at the very
        // start of this text node or right after whitespace - not just
        // "@" anywhere. Without the leading check, "email@FrenchGuy.com"
        // would get rewritten too, since only what follows the name was
        // being checked before.
        const pattern = new RegExp(`(^|\\s)@${escapeRegExp(customName)}(?=$|[^A-Za-z0-9_])`, "gi");
        text = text.replace(pattern, (_match, prefix) => `${prefix}@${login}`);
      }

      if (text !== original) {
        node.textContent = text;
        changed = true;
      }
    }

    if (!changed) return;

    // Contenteditable content doesn't keep a sensible caret position after a
    // text node is overwritten out from under it - park it at the end
    // (harmless either way here, since Enter/send immediately follows and
    // clears the box, but keeps things sane if the rewrite ever fires
    // without an immediate send).
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    editable.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText" }));
  };

  const safeRewriteChatInputMentions = (editable) => {
    try {
      rewriteChatInputMentions(editable);
    } catch (error) {
      console.error("Twitch Auto Claim Plus: rewriting custom-name mentions before send failed", error);
    }
  };

  const handleChatSendKeydown = (event) => {
    if (renamedUsersMap.size === 0) return;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;

    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute("contenteditable") !== "true") return;
    if (!target.closest(CHAT_SEND_FORM_SELECTOR) && !target.closest(CHAT_INPUT_CONTAINER_SELECTOR)) return;

    safeRewriteChatInputMentions(target);
  };

  // Click handling is scoped to "anywhere inside the send form" rather than
  // a specific send-button selector I have no way to verify without a live
  // capture (the same trap that caused the channel-header selector to miss
  // on the first two attempts) - this is safe to run broadly because the
  // rewrite is idempotent: once "@customName" has already become
  // "@reallogin", re-running it on an unrelated click inside the same form
  // (e.g. opening the emote picker) finds nothing left to change and no-ops.
  const handleChatSendClick = (event) => {
    if (renamedUsersMap.size === 0) return;

    const form = event.target instanceof HTMLElement ? event.target.closest(CHAT_SEND_FORM_SELECTOR) : null;
    if (!form) return;

    const editable = form.querySelector('[contenteditable="true"]');
    if (editable) safeRewriteChatInputMentions(editable);
  };

  let chatSendInterceptInstalled = false;
  const ensureChatSendIntercept = () => {
    if (chatSendInterceptInstalled) return;
    chatSendInterceptInstalled = true;
    // Capture phase, on document - fires before the event reaches Twitch's
    // own listeners (attached on/under the input itself), regardless of
    // whether those are plain DOM listeners or React's synthetic ones.
    document.addEventListener("keydown", handleChatSendKeydown, true);
    document.addEventListener("click", handleChatSendClick, true);
  };

  const ensureScanObserver = () => {
    const root = getObserverRoot();
    if (!root) return false;
    if (observer && observedRoot === root) return true;

    if (observer) observer.disconnect();
    observedRoot = root;
    observer = new MutationObserver((mutations) => {
      // mutationMightContainClaimButton itself is a real DOM scan (not just a
      // flag check) - skip it entirely when auto-claim is off rather than
      // running it on every mutation just to have queueClaimScan's own guard
      // throw the result away. On a busy chat page mutations fire on nearly
      // every message, so this is the difference between "auto-claim off"
      // meaning no scanning at all versus scanning at full rate for nothing.
      if (settings.autoClaim && mutationMightContainClaimButton(mutations)) queueClaimScan();
      ensureNavButton();
      safeApplyChannelHeaderRename();
      safeApplySideNavRenames();

      // Unconditional (not gated behind having any ignored/renamed users
      // configured) - the nickname pencil icon needs to appear on every chat
      // line even when nobody's been renamed yet, since that icon is how a
      // first custom name gets set in the first place.
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) safeScanChatLinesForUserOverrides(node);
        }
      }
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
      #${NAV_PANEL_ID} .ttnp-header-settings {
        margin-left: auto;
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

      .${NICKNAME_BUTTON_CLASS} {
        all: unset;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        margin-left: 4px;
        vertical-align: middle;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.35);
        opacity: 0;
        transition: opacity 120ms ease, color 120ms ease;
      }
      .chat-line__message:hover .${NICKNAME_BUTTON_CLASS},
      .seventv-message:hover .${NICKNAME_BUTTON_CLASS},
      .${NICKNAME_BUTTON_CLASS}:focus-visible {
        opacity: 1;
      }
      .${NICKNAME_BUTTON_CLASS}:hover {
        color: var(--twitch-tools-accent, #9146ff);
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

  // Same gear glyph as popup.html's own settings button, kept identical so
  // the two surfaces read as one visual system rather than two different
  // icon styles for the same action.
  const createGearIcon = () => {
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

    const circle = document.createElementNS(SVG_NS, "circle");
    for (const [key, value] of Object.entries({ cx: "12", cy: "12", r: "3" })) circle.setAttribute(key, value);
    svg.appendChild(circle);

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute(
      "d",
      "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82A1.65 1.65 0 0 0 3 13.09H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
    );
    svg.appendChild(path);
    return svg;
  };

  const buildNavPanelElement = () => {
    const arrow = createEl("div", { className: "ttnp-arrow" });

    const openSettingsButton = createEl("button", {
      className: "ttnp-icon-btn ttnp-header-settings",
      attrs: {
        type: "button",
        "data-action": "open-settings",
        title: "Open settings",
        "aria-label": "Open settings"
      }
    }, [createGearIcon()]);

    const header = createEl("div", { className: "ttnp-header" }, [
      createEl("img", { className: "ttnp-logo", attrs: { alt: "", src: chrome.runtime.getURL("icons/icon32.png") } }),
      createEl("span", { className: "ttnp-title", text: "Twitch Auto Claim Plus" }),
      openSettingsButton
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
      if (!target) return;

      if (target.dataset.action === "reset-points") {
        const confirmed = window.confirm("Reset the all-time points counter to 0? This can't be undone.");
        if (!confirmed) return;
        resetPointsTotal();
        renderNavPanel();
        return;
      }

      if (target.dataset.action === "open-settings") {
        // No response handling needed beyond swallowing chrome.runtime.lastError
        // - this is a convenience shortcut, not core functionality, and
        // background.js already logs/handles its own failure to open the
        // window. Closing the panel first so it isn't left open behind the
        // new settings window.
        closeNavPanel();
        chrome.runtime.sendMessage({ type: "TWITCH_TOOLS_OPEN_SETTINGS" }, () => {
          void chrome.runtime.lastError;
        });
      }
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
        const themeUpdate = {
          theme: selectedTheme,
          themeEnabled: selectedTheme !== "default",
          accent: THEME_PRESETS[selectedTheme]?.accent || DEFAULTS.accent
        };
        const nextSettings = normalizeSettings({ ...settings, ...themeUpdate });
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

  const DECLUTTER_STYLE_ID = "twitch-tools-declutter-style";

  // Deliberately independent of themeCss/applyTheme above - hiding a UI
  // element is a site-wide preference that has nothing to do with whether a
  // colour theme is active, so it gets its own <style> element rather than
  // being folded into the theme stylesheet (which is fully replaced/emptied
  // whenever theming is toggled off).
  const declutterCss = (hiddenElements) => {
    if (!hiddenElements.length) return "";

    const selectors = hiddenElements
      .map((id) => DECLUTTER_OPTIONS[id]?.selector)
      .filter(Boolean);
    if (!selectors.length) return "";

    return `${selectors.join(",\n")} {\n  display: none !important;\n}`;
  };

  const applyDeclutter = () => {
    let style = document.getElementById(DECLUTTER_STYLE_ID);
    const css = declutterCss(settings.hiddenElements);

    if (!css) {
      if (style) style.textContent = "";
      return;
    }

    if (!style) {
      style = document.createElement("style");
      style.id = DECLUTTER_STYLE_ID;
      document.documentElement.appendChild(style);
    }
    style.textContent = css;
  };

  const applyRuntimeState = (nextSettings, { runClaim = true } = {}) => {
    settings = normalizeSettings(nextSettings);
    ignoredUsersSet = new Set(settings.ignoredUsers);
    renamedUsersMap = new Map(Object.entries(settings.renamedUsers));
    applyTheme();
    applyDeclutter();
    renderNavPanel();
    // Claiming runs before the ignore/rename scan, and unconditionally (not
    // gated behind the scan succeeding) - auto-claim is this extension's
    // core job and must run even if the chat scan below fails outright.
    if (runClaim) claimBonus();
    // Scoped to the chat scroller (falls back to the whole document before
    // it exists, e.g. on a non-chat page) rather than skipped outright, so
    // messages already on screen get hidden/revealed/renamed immediately when
    // the ignore/rename lists themselves change, not just newly-arriving ones.
    safeScanChatLinesForUserOverrides(document.querySelector('[data-a-target="chat-scroller"]') || document);
    safeApplyChannelHeaderRename();
    safeApplySideNavRenames();
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
    totalClaimedPoints,
    visibleBonusButtons: isDashboardHost() ? 0 : candidateButtons().length,
    staleClaimButtonWarning
  });

  const startScanning = () => {
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = window.setInterval(() => {
      claimBonus();
      ensureNavButton();
      safeApplyChannelHeaderRename();
      safeApplySideNavRenames();
    }, SCAN_INTERVAL_MS);

    ensureScanObserver();
    ensureChatSendIntercept();
    claimBonus();
    ensureNavButton();
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) return;

    if (message.type === "TWITCH_TOOLS_UPDATE") {
      const nextSettings = normalizeSettings({ ...settings, ...message.settings });
      applyRuntimeState(nextSettings);
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

  // Belt-and-suspenders: startScanning() (which sets up the claim interval,
  // the mutation observer, and the nav button) must run even if something
  // unrelated inside loadSettings() throws - auto-claim is the entire point
  // of this extension and can't be allowed to depend on every downstream
  // settings-driven feature succeeding first.
  loadSettings()
    .catch((error) => {
      console.error("Twitch Auto Claim Plus: loadSettings failed, starting with defaults", error);
    })
    .then(() => {
      startScanning();
    });

  window.addEventListener("pagehide", () => {
    if (scanTimer) window.clearInterval(scanTimer);
    if (queuedScan) window.clearTimeout(queuedScan);
    if (observer) observer.disconnect();
    closeNavPanel();
  });
})();

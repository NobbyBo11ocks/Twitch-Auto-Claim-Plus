// Minimal, event-driven MV3 service worker - not a persistent background
// page. Its only job is opening the settings window on request from the
// in-page nav panel's gear icon (content.js), since content scripts have no
// access to chrome.windows at all (that namespace is only available to
// extension pages and background/service-worker contexts). Chrome tears this
// worker down when idle and wakes it again on the next message - it does no
// work and holds no state between requests.
"use strict";

const SETTINGS_WINDOW_WIDTH = 608;
const SETTINGS_WINDOW_HEIGHT = 488;
const CLAIM_TOTAL_KEY = "twitchToolsClaimSessionTotal";
const LEGACY_CLAIM_HISTORY_KEY = "twitchToolsClaimHistory";
let claimWriteQueue = Promise.resolve();

// Callback wrappers are deliberately used instead of relying on promise
// overloads: Chromium and Firefox both support this form consistently in
// their different MV3 background environments.
const localGet = (defaults) => new Promise((resolve, reject) => {
  chrome.storage.local.get(defaults, (stored) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve(stored);
  });
});
const localSet = (values) => new Promise((resolve, reject) => {
  chrome.storage.local.set(values, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve();
  });
});
const localRemove = (keys) => new Promise((resolve, reject) => {
  chrome.storage.local.remove(keys, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve();
  });
});

// Version 1.1.1 removed claim history. Delete records saved by older builds
// when the extension is installed or updated; the aggregate points total is
// intentionally preserved during upgrades.
chrome.runtime.onInstalled.addListener(() => {
  localRemove(LEGACY_CLAIM_HISTORY_KEY).catch(() => {});
});

// Serialize read/modify/write operations in the background context. Content
// scripts in several Twitch tabs can claim at nearly the same moment; doing
// the increment independently in each tab can otherwise lose one update.
const recordClaim = (claim) => {
  const operation = claimWriteQueue.then(async () => {
    const amount = Math.max(0, Math.floor(Number(claim?.amount) || 0));
    if (!amount) throw new TypeError("Invalid claim amount");

    const stored = await localGet({ [CLAIM_TOTAL_KEY]: 0 });
    const total = (Number(stored[CLAIM_TOTAL_KEY]) || 0) + amount;
    await localSet({ [CLAIM_TOTAL_KEY]: total });
    return { total };
  });

  claimWriteQueue = operation.catch(() => {});
  return operation;
};

const resetClaimTotal = () => {
  const operation = claimWriteQueue.then(async () => {
    await localSet({ [CLAIM_TOTAL_KEY]: 0 });
    await localRemove(LEGACY_CLAIM_HISTORY_KEY);
    return { total: 0 };
  });
  claimWriteQueue = operation.catch(() => {});
  return operation;
};

// Centers the new window against the browser window the request actually
// came from (the sender tab's own window), not some ambiguous "current
// window" from the service worker's own point of view - a service worker has
// no window/screen of its own to measure against the way a page does.
const computeCenteredPosition = async (senderWindowId) => {
  try {
    const reference = senderWindowId != null
      ? await chrome.windows.get(senderWindowId)
      : await chrome.windows.getCurrent();

    const left = Math.round((reference.left ?? 0) + Math.max(0, ((reference.width ?? SETTINGS_WINDOW_WIDTH) - SETTINGS_WINDOW_WIDTH) / 2));
    const top = Math.round((reference.top ?? 0) + Math.max(0, ((reference.height ?? SETTINGS_WINDOW_HEIGHT) - SETTINGS_WINDOW_HEIGHT) / 2));
    return { left, top };
  } catch {
    // Best effort only - chrome.windows.create below still works without an
    // explicit position, just not perfectly centered.
    return {};
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TWITCH_TOOLS_RECORD_CLAIM") {
    recordClaim(message.claim)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "TWITCH_TOOLS_RESET_CLAIMS") {
    resetClaimTotal()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type !== "TWITCH_TOOLS_OPEN_SETTINGS") return;

  (async () => {
    const position = await computeCenteredPosition(sender?.tab?.windowId);

    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL("popup.html?view=settings"),
        type: "popup",
        width: SETTINGS_WINDOW_WIDTH,
        height: SETTINGS_WINDOW_HEIGHT,
        ...position
      });
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

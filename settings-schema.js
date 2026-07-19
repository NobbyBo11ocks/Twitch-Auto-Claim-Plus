// Shared settings schema/validation, consumed by both content.js (content
// script) and popup.js (toolbar popup / floating window). Loaded as a plain
// top-level script (no IIFE), after theme-presets.js (DEFAULTS.accent reads
// THEME_PRESETS.default.accent) and declutter-options.js
// (normalizeHiddenElements validates against DECLUTTER_OPTIONS) and before
// each consumer:
// - manifest.json content_scripts lists this file after theme-presets.js and
//   declutter-options.js, before content.js
// - popup.html has a <script> tag for this file after theme-presets.js and
//   declutter-options.js, before popup.js
//
// This used to be duplicated in both files (with even a spelling difference
// between them - normalizeSettings vs normaliseSettings, though behavior was
// identical) - a real risk of drifting out of sync if one copy were edited
// without remembering the other. Keep this the single source of truth for
// what a valid settings object looks like.
const DEFAULTS = {
  autoClaim: true,
  themeEnabled: false,
  theme: "default",
  accent: THEME_PRESETS.default.accent,
  fontScale: 100,
  ignoredUsers: [],
  renamedUsers: {},
  hiddenElements: []
};

const DEPRECATED_SETTINGS_KEYS = ["logoStyle", "buttonStyle", "buttonRadius", "buttonGlow", "tagStyle", "claimToast", "channelOverrides"];

// Real Twitch account-name rules (4-25 chars, alphanumeric/underscore only,
// case-insensitive, no restriction on the first character - e.g. "150k" is
// a valid username) - used both to validate what a user types in and to
// normalize before matching against chat authors, so "SomeUser" and
// "someuser" are the same ignore entry.
const USERNAME_PATTERN = /^[a-z0-9_]{4,25}$/;

// chrome.storage.sync caps each stored item at 8,192 bytes and the whole
// area at ~100KB (see chrome.storage.sync.QUOTA_BYTES_PER_ITEM) - this list
// lives in that same synced settings object, so it's capped well below what
// even 200 25-character names could need, with room to spare for everything
// else stored alongside it.
const MAX_IGNORED_USERS = 200;

// Same chrome.storage.sync per-item cap as MAX_IGNORED_USERS above, but this
// list stores a username *and* a custom name per entry instead of just a
// username, so the per-entry byte cost is roughly double - worst case
// ("25-char username":"30-char custom name", quotes/colon/comma included) is
// about 61 bytes/entry. 100 entries is ~6.1KB, comfortably under the 8,192
// byte ceiling with room to spare for everything else stored alongside it.
const MAX_RENAMED_USERS = 100;
const MAX_CUSTOM_NAME_LENGTH = 30;

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
};

const normalizeIgnoredUsername = (value) => String(value || "").trim().toLowerCase();

// Custom names are free text (unlike usernames, they're not real Twitch
// account identifiers) - just collapse whitespace and cap the length so one
// entry can't blow the storage budget computed above.
const normalizeCustomName = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_CUSTOM_NAME_LENGTH);

const normalizeIgnoredUsers = (raw) => {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const cleaned = [];
  for (const value of raw) {
    const name = normalizeIgnoredUsername(value);
    if (!USERNAME_PATTERN.test(name) || seen.has(name)) continue;
    seen.add(name);
    cleaned.push(name);
    if (cleaned.length >= MAX_IGNORED_USERS) break;
  }
  return cleaned;
};

// renamedUsers maps a normalized Twitch username to the custom name that
// should display in its place - same username validity rule as the ignore
// list (USERNAME_PATTERN), reused so "a valid username" means one thing
// across both features.
const normalizeRenamedUsers = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const cleaned = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_RENAMED_USERS) break;
    const name = normalizeIgnoredUsername(key);
    if (!USERNAME_PATTERN.test(name) || Object.prototype.hasOwnProperty.call(cleaned, name)) continue;
    const customName = normalizeCustomName(value);
    if (!customName) continue;
    cleaned[name] = customName;
    count += 1;
  }
  return cleaned;
};

// hiddenElements is a list of DECLUTTER_OPTIONS keys, not free text - no
// MAX_* cap needed the way ignoredUsers/renamedUsers have one, since the
// dedup below already bounds it at Object.keys(DECLUTTER_OPTIONS).length.
// Validating against that registry (rather than accepting any string) means
// a future version that renames/removes an option automatically drops the
// stale id on next save instead of carrying dead entries forward forever.
const normalizeHiddenElements = (raw) => {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const cleaned = [];
  for (const value of raw) {
    const id = String(value || "");
    if (!Object.prototype.hasOwnProperty.call(DECLUTTER_OPTIONS, id) || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }
  return cleaned;
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
  next.ignoredUsers = normalizeIgnoredUsers(next.ignoredUsers);
  next.renamedUsers = normalizeRenamedUsers(next.renamedUsers);
  next.hiddenElements = normalizeHiddenElements(next.hiddenElements);
  return next;
};

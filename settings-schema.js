// Shared settings schema/validation, consumed by both content.js (content
// script) and popup.js (toolbar popup / floating window). Loaded as a plain
// top-level script (no IIFE), after theme-presets.js (DEFAULTS.accent reads
// THEME_PRESETS.default.accent) and before each consumer:
// - manifest.json content_scripts lists this file after theme-presets.js,
//   before content.js
// - popup.html has a <script> tag for this file after theme-presets.js,
//   before popup.js
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
  fontScale: 100
};

const DEPRECATED_SETTINGS_KEYS = ["logoStyle", "buttonStyle", "buttonRadius", "buttonGlow", "tagStyle"];

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

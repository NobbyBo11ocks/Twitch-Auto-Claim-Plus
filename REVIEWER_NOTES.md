# Reviewer notes

Extension name: Twitch Auto Claim Plus
Version: 1.0.4 (first public release - 1.0.0 was submitted and withdrawn before going live, so AMO won't accept that version string again. An intermediate 1.0.4 local diagnostic build, never submitted to AMO, is documented in its own changelog entry below; this is the corrected build that number was reserved for. Internal development builds leading up to this release are referenced throughout the changelog below as 1.6.9-1.6.18 - kept as-is rather than renumbered, since it's a real record of the testing this extension went through before its first submission.)

Purpose:
This extension adds optional Twitch-only styling and can auto-claim visible channel point bonus rewards. As of 1.6.11, clicking the toolbar icon no longer shows the standard anchored popup - popup.html immediately detects that context (via chrome.windows.getCurrent().type !== "popup") and hands off to a real chrome.windows.create() window instead, then closes itself. This exists because the anchored popup surface cannot be dragged or repositioned by any extension API on any browser; opening a real window is the only way to give the user something they can move, since that surface has a native OS title bar and normal window behavior. As of 1.6.9 there is also a small button injected into Twitch's own top navigation bar (immediately after the native "More Options" / ellipsis button, selector [data-a-target="ellipsis-button"]) for quick access to the same auto-claim toggle, theme picker, and points counter without leaving the page.

How to test:
1. Open a Twitch stream page.
2. Click the extension toolbar icon. The anchored popup will appear only very briefly (this is an unavoidable side effect of the redirect - the browser always renders default_popup before any script can react) before it closes itself and a separate, centered, movable window opens in its place showing the same UI. This window has a normal OS title bar and can be dragged, moved between monitors, and resized freely, which the anchored popup could never do.
3. In that window, toggle:
   - Auto-claim
   - Theme
   - Preset
   - Accent
   - Chat size
4. Verify the active Twitch tab updates immediately.
5. When a channel point bonus chest is visible on Twitch, the extension can detect and claim it if auto-claim is enabled.
6. In the Twitch top nav, click the small icon button just to the right of the native "More Options" (⋮) button. A panel opens showing the all-time points total (with a reset control), an auto-claim toggle, and a theme picker. Changing any of these updates the same chrome.storage.sync settings the window in step 2 uses, and its status view reflects the change on next refresh.
7. Picking a theme in the window from step 2 now recolors the window itself (background/borders/text), not just an accent swatch - it reads the same shared theme palette as the content script (theme-presets.js) and applies it to its own CSS custom properties. No new permissions were needed for this.

Permissions used:
- storage: saves extension settings (chrome.storage.sync) and the all-time claimed-points total (chrome.storage.local)
- tabs: finds the active Twitch tab so popup settings can be read/applied for that tab
- host permissions for twitch.tv: content script (auto-claim + optional theme CSS) runs only on Twitch pages

Data:
This extension does not require account credentials and does not transmit any user data. The codebase makes no network requests of its own (no fetch/XHR/WebSocket anywhere). The only outbound connection is a plain, static link in the popup footer to the developer's public Discord server (https://discord.gg/bke5DEUJzE) for support/community — it only navigates if the user clicks it (target="_blank" rel="noopener noreferrer"), the extension does not open, track, or otherwise act on it programmatically.

Notes:
- Intended for Twitch pages only.
- Auto-claim intentionally does not scan or click anything on dashboard.twitch.tv (the creator/streamer management area) — only on viewer-facing Twitch pages.
- As of 1.6.9, the content script injects one small button into Twitch's native top nav (see "How to test" above) and, on click, a floating panel appended to document.body. Both are namespaced under IDs/classes prefixed "twitch-tools-"/"ttnp-" and their own scoped <style> tag; no existing Twitch elements are modified, removed, or hidden. The panel closes on outside click, Escape, or page unload.
- As of 1.6.10, theme-presets.js holds the full theme palette data and is loaded before both content.js (content_scripts) and popup.js (popup.html script tag), so both consumers share one source of truth instead of maintaining separate copies.
- As of 1.6.11, popup.html always runs the same script regardless of how it's opened (anchored popup vs. the chrome.windows.create() window it redirects to). The redirect check (chrome.windows.getCurrent().type !== "popup") only triggers the hand-off once, since the newly created window genuinely reports type "popup" and takes the normal render path instead - verified this doesn't loop by polling chrome.windows.getAll() for several seconds after opening.
- As of 1.6.12, the nav panel's points total now refreshes live in two cases that previously required closing and reopening the panel to see: (1) a claim happening while the panel is open in the same tab, (2) the total changing from elsewhere - another Twitch tab claiming, or a reset triggered from the popup - picked up via chrome.storage.onChanged on the "local" area.
- As of 1.6.13: the popup/floating window had the same gap the nav panel already had fixed in 1.6.12, just not yet applied there - its status view (points total, plus last-claim/theme/etc. alongside it) did not refresh on its own while left open if a claim happened elsewhere. It now listens for chrome.storage.onChanged on the "local" area the same way and re-fetches status when the total changes, keeping every field consistent together rather than patching the number in isolation. Verified against the real extension: seeded a claim, left the window open and untouched, triggered a second claim on the Twitch tab, confirmed the total updated without any click.
- As of 1.6.13, the toolbar-icon hand-off (see 1.6.11 above) is now guarded against failure: if chrome.windows.create() throws or does not return a usable window for any reason, popup.html falls back to rendering normally in place instead of silently closing into nothing. Previously a failed hand-off would call window.close() unconditionally right after attempting creation, which could leave the user with no UI at all if creation failed. Verified both failure modes (synchronous throw, and a callback reporting no window) fall back to a fully working popup.
- As of 1.6.14: fixed a real bug found from the developer's own screenshots on a real Windows machine (not reproducible in this sandbox, which runs at 100% display scaling) - the floating window's one-time auto-fit measured its own width and requested that exact value back from chrome.windows.update(). On a display with non-100% DPI scaling (125%/150%, common on Windows), the OS can apply that request a couple of physical pixels short of what was asked, permanently landing below the CSS's hardcoded 388px body width - since the fit only runs once per window, every theme/content change afterward showed a horizontal scrollbar for the rest of that window's life. Fixed by not measuring width at all (it's a fixed CSS value, not something that varies with content) and requesting a small fixed buffer above it instead; only height is still measured, since that's the dimension that actually varies.
- As of 1.6.14, ran a full WCAG contrast audit across all theme presets (text/muted/accent against every background tone they're actually used on, plus each theme's own buttonText against its accent for the text-selection highlight). Found and fixed: Candy Light's accent failed contrast against every background tone it's used on, including white button text on its own accent (2.34-3.53:1, needs 4.5:1) - replaced with a darker pink in the same family. Arctic Light's accent passed against dark backgrounds but failed against its own lighter panel tones (3.68-4.30:1) - replaced with a darker blue. Cyber Neon, Ember Red, Rose Noir, and Grape Pop each had white buttonText against a light-toned accent (3.10-3.20:1, only used for the text-selection highlight color) - replaced with each theme's own existing dark input-field color, which was already in the palette. One narrower edge case remains open by choice: five dark themes' accent color has borderline contrast (3.80-4.35:1) against their own surface2 tone specifically (a lighter hover/panel shade) - narrower real-world exposure than the fixed issues, and fixing it would mean darkening five more accent colors and changing their look, so left as a known finding rather than changed unprompted.
- As of 1.6.15: the 1.6.14 width fix addressed a real but secondary contributor to a persistent scrollbar bug in the floating window - the actual primary cause was that the one-time auto-fit only ever measured content height for whichever theme happened to be active when the window first opened. Switching themes afterward (without closing/reopening the window) changes the preset description text's wrapped line count - some are one line, some wrap to two - which changes .app's real height without the window ever re-fitting to match, so content overflowed the stale fixed height and showed a vertical scrollbar, which itself ate into the horizontal space and could trigger a horizontal one too. Fixed with a ResizeObserver on .app that re-fits the window on every actual size change, not just once at load. Verified by cycling through all 16 themes in a single already-open window and checking for scrollbars at every step - all clean, height correctly alternates between 522px and 560px matching exactly which descriptions wrap to a second line. Also restored a type check inside the fit function itself (win.type === "popup") that had been dropped during the 1.6.13 fallback-safety refactor - without it, if the hand-off to the floating window ever failed and popup.html fell back to rendering in place (see 1.6.13 above), this function would have tried to resize the user's actual browser window instead of a no-op. Verified directly: forced the fallback path and confirmed chrome.windows.update is never called in that case.
- As of 1.6.15, added two new theme presets: Graphite Mono (near-monochrome dark, steel-gray accent) and Paper Light (warm sepia light theme, amber accent) - a third light option distinct from Arctic's cool blue and Candy's pink. Both were designed with the 1.6.14 contrast audit's pass criteria from the start (checked against all four background tones plus buttonText/accent before being added, not after) and pass with comfortable margin (5.18-17.69:1). Both appear automatically in the nav panel's theme dropdown with no content.js changes needed, since that list is built dynamically from theme-presets.js.
- As of 1.6.16: the 1.6.15 fix's flat +8px width buffer (added specifically to survive OS DPI-scaling rounding) traded the scrollbar bug for a permanent, always-visible gap of body background past .app's right edge on every system where that rounding never actually happens - which is the common case. Replaced with a measure-then-verify approach: request the real measured width (388px, matching the CSS exactly) with no padding, then check window.innerWidth after the resize actually lands and only issue a corrective follow-up if a real shortfall shows up. Verified both properties hold: cycled all 16 themes in the real multi-window extension and confirmed an exact 388px fit with zero gap and zero scrollbar at every step; separately confirmed via a mock that simulates an actual rounding shortfall that the correction logic detects it and computes a sensible compensating value rather than never firing.
- As of 1.6.17, a code-quality sweep (static analysis via eslint plus manual tracing, not just re-testing existing behavior) found and fixed several things accumulated from iterative work:
  - content.js's NATIVE_PALETTE constant was fully dead - interfaceCss ignored its own palette parameter (already prefixed _p), and the panel-variable template only ever read from it via a ternary that short-circuits away from evaluating it whenever a theme isn't active, so its field values were never actually read anywhere regardless of what was assigned. Removed the constant and the dead ternary branch that referenced it.
  - interfaceCss itself was removed entirely after tracing both of its call sites: one always resolved to a plain call to accentCss(accent), the other always passed includeAccentVars: false and therefore always contributed an empty string to the generated stylesheet - a no-op interpolation. Both call sites were simplified to not need the wrapper at all.
  - popup.css had .icon-button split across two non-adjacent rule blocks with unrelated selectors interleaved between them (not conflicting, just messy from incremental edits) - merged into one. Verified byte-identical computed styles before and after.
  - DEFAULTS, DEPRECATED_SETTINGS_KEYS, clampNumber, and settings validation (normalizeSettings in content.js, normaliseSettings in popup.js - even the spelling had drifted) were duplicated identically or near-identically across both files, a real risk of the two copies drifting out of sync if one were edited without remembering the other. Extracted into a new shared settings-schema.js, loaded the same way theme-presets.js already is (content_scripts.js array, and a <script> tag in popup.html), both after theme-presets.js and before their respective consumers. Standardized on the normalizeSettings spelling throughout.
  - fitFloatingWindowToContent() was re-querying chrome.windows.getCurrent() on every single call, despite being invoked repeatedly per page load (once at initial load, then again on every ResizeObserver-triggered re-fit as themes change) - a window's own id/type don't change during its lifetime. boot() now caches the confirmed window id once, only when windowType has actually been verified as "popup" (left null in the fallback-failure case, preserving the exact same safety guarantee as before, reverified directly afterward).
  - Fixed one stale piece of documentation: REVIEWER_NOTES.md's permissions section still called the points total a "session" total, inconsistent with "all-time" used everywhere in the actual UI and in every other note in this file.
  - Re-ran the entire existing test suite after each change (not just at the end) - all 16 themes with no scrollbar, exact 388px fit, no hand-off loop, correct centering, live points sync (single tab, cross-tab, and via the floating window), and the fallback-safety guarantee all still hold exactly as before.
- Popup and content scripts are plain source, not bundled/obfuscated.
- The window's footer has three icon controls: refresh status, reset settings, and a link to the developer's Discord server.
- As of 1.6.18, fixed the all-time points total never actually increasing in
  real usage. Root cause: extractClaimAmount() (aria-label/title/textContent
  parsing on the claim button and its ancestors) only ever pays off on a
  hypothetical Twitch UI variant that embeds the reward size directly in the
  button's own text - on the actual site the button's accessible text is just
  "Claim Bonus" with no number anywhere near it, so `amount` was 0 on every
  real claim and totalClaimedPoints could never move past 0, even though the
  button was still being found and clicked correctly (auto-claim itself was
  never broken - only the counter was). Confirmed this against how other
  independent Twitch auto-claim tools handle the same button: none of them
  attempt to read a point value off it either, they either don't track a
  total at all or watch the viewer's own points balance instead.
  Fix: added readPointsBalance(), which reads the viewer's persistent
  channel-points balance widget next to the chat box (matched via layered
  data-test-selector/data-a-target selectors, the same defensive multi-selector
  approach candidateButtons() already uses, since Twitch's own CSS class names
  rotate on every deploy but these QA-oriented attributes tend to stay put).
  claimBonus() now reads that balance immediately before clicking and again
  ~1.5s after (BALANCE_READ_DELAY_MS, comfortably inside CLAIM_COOLDOWN_MS so
  two measurement windows can't overlap); a positive difference is what the
  claim earned. The old text-parsing path is kept and tried first since it's
  free and still wins immediately on the off chance a given claim button does
  carry a number - the balance-diff only runs when that comes back empty.
  If the balance widget can't be found at all, or the reading doesn't come out
  positive (most commonly: Twitch just hadn't finished updating the widget
  yet), the total is left untouched rather than recording a false 0 - the
  claim itself still happens either way. getStatus() now also reports
  lastClaimSource ("text" | "balance-delta" | null) so which path supplied a
  given number can be checked later if Twitch's markup shifts again.
  Verified with a from-scratch harness (jsdom + a mock chrome.storage/
  chrome.tabs bridge wired the same way real cross-context messaging works,
  not reimplemented copies of the logic) across three cases: (1) the old
  fast text-carrying-a-number path still works and still reaches both the
  in-page nav panel and the popup/floating window; (2) the realistic case -
  button text has no number, balance widget updates shortly after the click -
  is now correctly picked up via the delta and reaches both surfaces; (3) no
  balance widget present at all still clicks the button, records nothing
  rather than a fabricated amount, and doesn't throw. Since Twitch's exact
  current DOM couldn't be checked against a live page from here, the selector
  list is deliberately layered/defensive and worth a quick spot-check with
  devtools open the next time a bonus is live, the same maintenance note the
  rest of this project already carries for candidateButtons().
  Also tightened isTwitchUrl() in popup.js from a hardcoded "https://" check
  to "https?://", matching manifest.json's own "*://" match pattern (which
  WebExtensions defines as http-or-https) - Twitch is https-only in practice
  so this had no observed effect, just removed a latent disagreement between
  the popup's own check and what the content script is actually permitted
  to run on.
- 1.0.0 is the first public release. Version reset from the 1.6.x internal
  build numbers above - see the note at the top of this file. Two small UI
  changes made as part of getting this release-ready:
  - Removed the nav panel's footer hint ("More options via the toolbar icon")
    entirely, along with its now-unused .ttnp-footer CSS rule - not just the
    text, since an empty bordered strip with no content would have been its
    own loose end.
  - Dropped the "(all-time)" qualifier next to "Points claimed" on both
    surfaces (nav panel and popup/floating window) - the label reads fine on
    its own. Removed the now-unused .ttnp-meta rule in content.js and
    .stat-label-meta rule in popup.css along with it. Left the wording alone
    in the two reset-confirmation dialogs ("Reset the all-time points counter
    to 0?"), since that's a different thing - the extra word there is doing
    real work clarifying an irreversible action, not just labeling a stat.
  Re-ran the full harness suite after each change (fast text-amount path,
  realistic balance-delta path, no-widget-present path, plus a direct check
  of the rendered label text and absence of the footer element on both
  surfaces) - all still pass. Also swept both content.js's generated nav-panel
  CSS and popup.html/popup.css for any other class defined but unused, or used
  but unstyled - none found beyond the two removed above (popup.css's "flash"
  class flags as unused by a static markup scan, but it's applied/removed at
  runtime via classList in popup.js's flashStatus(), not dead).
- As of 1.0.4 (LOCAL DIAGNOSTIC BUILD, not submitted to AMO): confirmed on a
  real Twitch page that the 1.0.0 balance-delta fallback (see above) is not
  crediting real claims - the points total stayed at 0 despite "Last claim"
  showing a recent timestamp, meaning a button was found and clicked but no
  amount got attributed via either path. This can only be root-caused against
  the actual live DOM, which isn't something reachable from the environment
  this extension is built in. Added temporary, clearly-prefixed
  ([TwitchAutoClaimPlus]) console logging rather than guessing at another
  selector list blind: readPointsBalance() now logs, per call, which selector
  (if any) matched, every raw text node found inside a matched container (even
  non-numeric ones, so the real format shows up if it isn't a bare number),
  and - if nothing in POINTS_SUMMARY_SELECTORS matched at all - a broader
  sweep for any element anywhere on the page whose class/data-test-selector/
  data-a-target mentions "community-points", to tell "nothing like this
  widget exists here" apart from "it exists but isn't shaped the way this
  code assumes." claimBonus() additionally logs the matched button's own
  identifying attributes (aria-label/title/data-test-selector/data-a-target/
  text) so a wrong-button match would also show up, plus balanceBefore/
  balanceAfter/delta for every claim attempt. Re-ran the full harness suite
  with the logging in place - all four scenarios still pass identically, the
  added console.log calls are side-effect only. Next step is a real console
  capture from an actual claim on a live Twitch page; the fix itself is
  deliberately not guessed at again until that data is in hand.
- As of 1.0.4 (this build - the diagnostic entry above was an intermediate,
  never-submitted 1.0.4): a real console capture from a live claim on Twitch
  came back, and it disproved the balance-diff approach outright rather than
  just needing new selectors. The real claim button matched: aria-label
  "Claim Bonus", no data-test-selector, no data-a-target, no text - confirming
  extractClaimAmount will return 0 in the ordinary case, as assumed. But the
  balance widget itself renders as an abbreviated string ("61.1K"), not a bare
  integer - PLAIN_NUMBER_PATTERN never matched it, and even parsed, a number
  rounded to 3 significant figures can't reliably reveal a change as small as
  one claim (a 60-point change is within "61.1K"'s own rounding noise), so
  this approach was never going to work reliably against a real, non-trivial
  balance, no matter which selector found it. Removed readPointsBalance(),
  POINTS_SUMMARY_SELECTORS, and PLAIN_NUMBER_PATTERN entirely rather than
  patch a fundamentally-wrong signal.
  The same capture showed a better one already on the page: Twitch renders a
  "+<amount>" indicator (community-points-summary__points-add-text) in the
  community-points-summary widget when points are earned - literally "+60"
  for this claim. That's an exact figure Twitch computed itself, not something
  inferred from a diff. Added readPointsAddText() (checked via layered
  data-test-selector/class selectors, same defensive style as the rest of this
  file) and watchForPointsAdd(), which polls for it every 200ms for up to 3s
  after a claim (it's a brief animated toast, not a persistent value, so a
  single fixed-delay check isn't safe) and compares against whatever text (if
  any) was already showing before the click, so a leftover indicator from an
  earlier claim that never updates can't get double-counted as a new one.
  lastClaimSource's possible values changed from "text"/"balance-delta" to
  "text"/"points-add-indicator" to match.
  Removed all temporary [TwitchAutoClaimPlus] console logging from the
  diagnostic build now that it's served its purpose - this build has none.
  Verified: the harness's balance-diff scenario was itself replaced (it was
  testing a mechanism now known to be wrong) with one matching the real
  capture's shape - empty-text claim button, abbreviated balance widget, a
  +60 indicator appearing ~500ms after the click - and it's correctly read
  and credited. Added a new scenario for the stale-indicator case specifically
  (an unrelated +60 already on screen before the claim, nothing changes after
  it) confirming it's correctly left uncredited rather than double-counted.
  The pre-existing fast-text-path, no-widget-present, and label/footer
  scenarios all still pass unchanged. Still can't verify this against live
  Twitch directly from here, so - same as the mechanism it replaces - worth a
  live spot-check next time a bonus is claimed for real, but this one is built
  from an actual capture of that real button and widget rather than a guess.

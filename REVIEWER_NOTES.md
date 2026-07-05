# Reviewer notes

Extension name: Twitch Auto Claim Plus
Version: 1.6.9

Purpose:
This extension adds optional Twitch-only styling and can auto-claim visible channel point bonus rewards. Settings live in the toolbar popup; as of 1.6.9 there is also a small button injected into Twitch's own top navigation bar (immediately after the native "More Options" / ellipsis button, selector [data-a-target="ellipsis-button"]) for quick access to the same auto-claim toggle, theme picker, and points counter without leaving the page.

How to test:
1. Open a Twitch stream page.
2. Click the extension toolbar icon to open the popup.
3. Toggle:
   - Auto-claim
   - Theme
   - Preset
   - Accent
   - Chat size
4. Verify the active Twitch tab updates immediately.
5. When a channel point bonus chest is visible on Twitch, the extension can detect and claim it if auto-claim is enabled.
6. In the Twitch top nav, click the small icon button just to the right of the native "More Options" (⋮) button. A panel opens showing the all-time points total (with a reset control), an auto-claim toggle, and a theme picker. Changing any of these updates the same chrome.storage.sync settings the popup uses, and the popup's own status view reflects the change on next refresh.

Permissions used:
- storage: saves extension settings (chrome.storage.sync) and the running session point total (chrome.storage.local)
- tabs: finds the active Twitch tab so popup settings can be read/applied for that tab
- host permissions for twitch.tv: content script (auto-claim + optional theme CSS) runs only on Twitch pages

Data:
This extension does not require account credentials and does not transmit any user data. The codebase makes no network requests of its own (no fetch/XHR/WebSocket anywhere). The only outbound connection is a plain, static link in the popup footer to the developer's public Discord server (https://discord.gg/bke5DEUJzE) for support/community — it only navigates if the user clicks it (target="_blank" rel="noopener noreferrer"), the extension does not open, track, or otherwise act on it programmatically.

Notes:
- Intended for Twitch pages only.
- Auto-claim intentionally does not scan or click anything on dashboard.twitch.tv (the creator/streamer management area) — only on viewer-facing Twitch pages.
- As of 1.6.9, the content script injects one small button into Twitch's native top nav (see "How to test" above) and, on click, a floating panel appended to document.body. Both are namespaced under IDs/classes prefixed "twitch-tools-"/"ttnp-" and their own scoped <style> tag; no existing Twitch elements are modified, removed, or hidden. The panel closes on outside click, Escape, or page unload.
- Popup and content scripts are plain source, not bundled/obfuscated.
- Popup footer has three icon controls: refresh status, reset settings, and a link to the developer's Discord server.

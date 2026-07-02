# Reviewer notes

Extension name: Twitch Auto Claim Plus
Version: 1.6.7

Purpose:
This extension adds optional Twitch-only styling and can auto-claim visible channel point bonus rewards. All controls live in the toolbar popup — the extension does not inject any icon, button, or panel into the Twitch page itself.

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

Permissions used:
- storage: saves extension settings (chrome.storage.sync) and the running session point total (chrome.storage.local)
- tabs: finds the active Twitch tab so popup settings can be read/applied for that tab
- host permissions for twitch.tv: content script (auto-claim + optional theme CSS) runs only on Twitch pages

Data:
This extension does not require account credentials and does not transmit any user data. The codebase makes no network requests of its own (no fetch/XHR/WebSocket anywhere). The only outbound connection is a plain, static link in the popup footer to the developer's public Discord server (https://discord.gg/bke5DEUJzE) for support/community — it only navigates if the user clicks it (target="_blank" rel="noopener noreferrer"), the extension does not open, track, or otherwise act on it programmatically.

Notes:
- Intended for Twitch pages only.
- Auto-claim intentionally does not scan or click anything on dashboard.twitch.tv (the creator/streamer management area) — only on viewer-facing Twitch pages.
- No content is injected into the Twitch page's own UI beyond an optional stylesheet (for the theme feature); there is no floating icon, button, or panel added to the page.
- Popup and content scripts are plain source, not bundled/obfuscated.
- Popup footer has three icon controls: refresh status, reset settings, and a link to the developer's Discord server.

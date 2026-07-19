// Shared registry of "hide this Twitch UI element" toggles, consumed by both
// content.js (which owns the actual CSS selectors and injects the hide
// rules) and popup.js (which renders one checkbox per entry from label/desc
// alone, never touching `selector`). Loaded as a plain top-level script (no
// IIFE), before settings-schema.js (DEFAULTS/normalizeSettings validate
// hiddenElements against Object.keys(DECLUTTER_OPTIONS)) and before each
// consumer:
// - manifest.json content_scripts lists this file first, before
//   settings-schema.js and content.js
// - popup.html has a <script> tag for this file first, before
//   settings-schema.js and popup.js
//
// Every selector below was checked against FrankerFaceZ's current, live
// source (FrankerFaceZ/FrankerFaceZ, src/sites/twitch-twilight/modules/
// css_tweaks/index.js) and cross-checked that each one is actually wired to a
// live, non-commented-out setting - not just present in FFZ's own selector
// map, which turned out to contain several genuinely dead/orphaned entries
// (no settings.add()/toggle() call anywhere in the current codebase
// referencing them - e.g. the "Discover link" toggle is fully commented out,
// and 'last-x-events'/'pinned-cheer' are defined but never actually
// referenced by any live feature). Entries below marked "actively wired in
// FFZ" were confirmed live and in current use; "unconfirmed" entries carry a
// real risk of being stale and are called out as such rather than presented
// with the same confidence as the rest.
const DECLUTTER_OPTIONS = {
  stories: {
    label: "Stories",
    desc: "Hide the Stories tray in the sidebar",
    // Actively wired in FFZ (layout.side-nav.hide-stories). All three
    // alternates kept, not just the first - the second and third exist
    // specifically to catch layout variants the first alone would miss.
    selector:
      '#side-nav [class*="storiesLeftNavSection"], #side-nav [style*="margin-top"]:has(button [class*="storiesLeftNavSectionCollapsedButton"]), .common-centered-column div:has(> .scrollable-area .sr-only)'
  },
  bits: {
    label: "Bits button",
    desc: "Hide bits/cheer buttons in chat and the top nav",
    // Actively wired in FFZ (chat.bits.show) and matches FFZ's shipped
    // styles/hide-bits.scss exactly.
    selector:
      '.get-bits-button, .gem-notif-icon, .chat-input button[data-a-target="bits-button"], button[data-a-target="top-nav-get-bits-button"]'
  },
  giftSubButtons: {
    label: "Gift sub buttons",
    desc: "Hide gift-a-sub buttons in the channel header",
    // Actively wired in FFZ (channel.gift-sub-buttons.hide).
    selector: '.channel-info-content button[data-a-target="gift-button"]'
  },
  manageSub: {
    label: "Subscribe / Manage Sub",
    desc: "Hide the subscribe button, or the Manage Sub button if you're already subscribed",
    // The earlier assumption here was wrong, confirmed via a real DOM capture
    // (right-click > Inspect > Copy outerHTML) on an already-subscribed
    // channel: the actual button is
    // <button aria-label="Manage Your Sub" data-a-target="manage-sub-button"
    //   data-test-selector="manage-sub-button">
    // - a genuinely different attribute from FFZ's subscribe-button target,
    // not the same stable one across both states as previously assumed.
    // Twitch really does swap attributes between the not-yet-subscribed and
    // already-subscribed states here, at least on this button. Both are kept
    // together so the toggle works regardless of which state you're in.
    selector:
      'button[data-a-target="subscribe-button"], button[data-a-target="manage-sub-button"], button[data-test-selector="manage-sub-button"]'
  },
  followButton: {
    label: "Follow button",
    desc: "Hide the Follow button on channel pages",
    // The already-following state is fully confirmed via a real live DOM
    // capture: <button aria-label="Unfollow 150k" data-a-target=
    // "unfollow-button" data-test-selector="unfollow-button">, matching what
    // both FFZ and 7TV ship. The not-yet-following "Follow" state hasn't been
    // captured directly, and the same capture session found a neighbouring
    // button (notifications) that turned out to carry no data-a-target/
    // data-test-selector at all despite other extensions assuming one - so
    // rather than assume this one definitely still has "follow-button", an
    // aria-label fallback is added using the exact naming pattern confirmed
    // for Unfollow ("Unfollow <channel>"): [aria-label^="Follow " i] matches
    // "Follow <channel>" but not "Unfollow <channel>" (it doesn't start with
    // "Follow"), so it can't double-hide the same button both ways.
    selector:
      'button[data-test-selector="unfollow-button"], button[data-test-selector="follow-button"], button[aria-label^="Follow " i]'
  },
  notifications: {
    label: "Notifications bell",
    desc: "Hide the channel notification bell button",
    // The 7TV/FFZ-sourced data-a-target="notifications-toggle" was wrong -
    // a real live DOM capture (right-click > Inspect > Copy outerHTML) shows
    // Twitch's actual current button carries no data-a-target or
    // data-test-selector at all:
    // <button aria-expanded="false" aria-label="Modify channel notification
    //   preferences" class="ScCoreButton-sc-ocjdkq-0 yezmM">
    // - the class is a hashed styled-components name shared with unrelated
    // buttons (confirmed from the same capture: the Unfollow button uses the
    // identical "ScCoreButton-sc-ocjdkq-0 yezmM" base class), so aria-label
    // is the only thing left that's actually specific to this button. Kept
    // as a substring match (*=, case-insensitive) rather than a full exact
    // string, matching the same defensive style content.js's own
    // isLikelyClaimButton already uses for aria-label matching elsewhere in
    // this codebase - resilient to Twitch tweaking the exact wording without
    // changing the core phrase. The old attribute selector is kept alongside
    // in case some other page/layout variant still uses it.
    selector:
      'button[aria-label*="notification preferences" i], button[data-a-target="notifications-toggle"]'
  },
  events: {
    label: "Event bar",
    desc: "Hide the event banner that appears above the player during hype trains and other ongoing events",
    // Actively wired in FFZ (player.hide-event-bar, in player.jsx - "Hide the
    // Event Bar which appears above the player when there is an ongoing
    // event for the current channel"). A second alternate this registry
    // previously carried (.last-x-events_container) was dropped after
    // confirming it has no live wiring anywhere in FFZ's current source -
    // likely dead/stale, not worth the false confidence of including it.
    selector: '.channel-root .live-event-banner-ui__header'
  },
  primeOffers: {
    label: "Prime/Turbo offers",
    desc: "Hide Prime Gaming, Turbo, and Discover Luna promo banners",
    // Actively wired in FFZ (layout.prime-offers for .top-nav__prime;
    // layout.hide-discover-luna for the try-presto-link). The standalone
    // "Discover" toggle this registry previously had was removed entirely -
    // its core selector (.navigation-link[data-a-target="discover-link"])
    // is commented out in FFZ's own current source, meaning even FFZ no
    // longer trusts it; only the Discover Luna promo link (a different,
    // still-active target) survives, folded in here since it's the same
    // kind of promotional banner.
    selector:
      '.top-nav__prime, .subtember-gradient, .top-nav__external-link[data-a-target="try-presto-link"]'
  },
  whispers: {
    label: "Whispers",
    desc: "Hide the whispers button and open whisper threads",
    // Actively wired in FFZ (whispers.show).
    selector: 'body .whispers-open-threads, .tw-core-button[data-a-target="whisper-box-button"], .whispers__pill'
  },
  streamTags: {
    label: "Stream tags",
    desc: "Hide the tag pills shown under the channel title (not the game/category link)",
    // Highest-confidence entry in this whole registry - taken directly from
    // a live DOM capture (right-click > Inspect > Copy outerHTML) rather
    // than inferred from another extension's source. Every tag pill is an
    // <a aria-label="Tag, English" data-a-target="English"
    //   class="ScTag-sc-ajnfk3-0 biuEEk tw-tag" href="/directory/all/tags/English">
    // - .tw-tag is a real, semantic (non-hashed) class shared by all of them,
    // unlike the styled-components classes elsewhere on the same element.
    // data-a-target is the tag's own name (e.g. "English", "CS2"), not a
    // fixed value, so it's not useful as a selector target here - the href
    // pattern is used as a second, independent signal instead. Deliberately
    // does not touch the game/category link right next to these tags
    // (a[data-a-target="stream-game-link"], a different class "tw-link") -
    // that's a distinct thing from a tag, and hiding it wasn't asked for.
    selector: '.tw-tag, a[href*="/directory/all/tags/"]'
  },
  streamTitle: {
    label: "Stream title",
    desc: "Hide the channel's stream title text below the video",
    // Direct live DOM capture (right-click > Inspect > Copy outerHTML):
    // <p data-a-target="stream-title" dir="auto" title="..."
    //   class="CoreText-sc-1txzju1-0 haaXAy">...</p>
    // data-a-target="stream-title" is a clean, semantic attribute - same
    // confidence tier as streamTags above, not inferred from another
    // extension's source.
    selector: 'p[data-a-target="stream-title"]'
  },
  pinnedMessages: {
    label: "Pinned messages",
    desc: "Hide messages pinned by a moderator at the top of chat",
    // Distinct from "Cheer leaderboard" below - this is Twitch's general
    // pin-any-message moderation feature, not the bits/cheer leaderboard.
    // .pinned-chat__message (BetterTTV's current source, src/watchers/chat.js)
    // covers the message *text* - confirmed directly against a real, live
    // pinned message that this alone left the header/card chrome around it
    // fully visible. The header wrapper is 7TV's actual currently-shipping
    // CSS for it (SevenTV/Extension, src/site/twitch.tv/modules/
    // hidden-elements/HiddenElementsModule.vue's own <style> block: 7TV
    // itself uses div[class^="community-highlight-stack"], a starts-with
    // attribute match) - but that regressed here: ^= only matches if that
    // string is the very first thing in the element's class attribute, so if
    // the real element lists any other class before it (very plausible on
    // Twitch's own multi-class elements), the whole rule silently fails to
    // match anything. Switched to *= (substring, matches the name anywhere in
    // the attribute regardless of what else is listed) plus the plain class
    // selector as a third layer - strictly broader than either alone, never
    // narrower, so this can only match in more cases than before, not fewer.
    selector:
      '.community-highlight-stack__card, div[class*="community-highlight-stack"], div[class*="community-highlight"], .pinned-chat__message'
  },
  leaderboard: {
    label: "Chat leaderboard / goal",
    desc: "Hide the rotating Bits, gifts, subs, viewers, and subscription-goal banner above chat",
    // The old 7TV-derived positional rule matched one element in Twitch's
    // current chat layout but not the visible leaderboard (confirmed by a
    // live user capture), so it produced a false-positive match while
    // leaving the banner on screen. Target the leaderboard's semantic child
    // classes and hide their immediate chat-content wrapper instead. The
    // channel-leaderboard-container and camelCase class-fragment fallbacks
    // cover older and alternate Twitch layouts without relying on child
    // position.
    selector:
      '.chat-room__content > div:has(.channel-leaderboard-header-rotating), .chat-room__content > div:has(.channel-leaderboard-header-rotating__users), .chat-room__content > div:has(.bits-leaderboard-expanded-top-three-entry), .chat-room__content .channel-leaderboard-header-rotating, .chat-room__content .leaderboard-header-tabbed-layout, .chat-room__content [class*="channel-leaderboard-header"], .channel-leaderboard-container, [class*="channelLeaderboard"], .pinned-cheer, .pinned-cheer-v2, .channel-leaderboard, .channel-leaderboard-marquee, div[data-test-selector="channel-leaderboard-container"]'
  },
  watchStreak: {
    label: "Watch streak badge",
    desc: "Hide the flame + \"Watch Streak N\" badge under followed channels in the sidebar",
    // Direct live DOM capture (right-click > Inspect > Copy outerHTML):
    // <div class="Layout-sc-1xcs6mc-0 hMzOYz">
    //   <div class="Layout-sc-1xcs6mc-0 gigGig"><svg>...flame icon...</svg></div>
    //   <p title="Watch Streak 1" class="CoreText-sc-1txzju1-0 dhIBcW">Watch Streak 1</p>
    // </div>
    // No data-a-target/data-test-selector anywhere in this element - only
    // hashed styled-components classes (which can change on any Twitch
    // redeploy) and the title attribute, which itself isn't a fixed string
    // (the streak count varies: "Watch Streak 1", "Watch Streak 2", ...), so
    // it's matched as a case-insensitive prefix rather than an exact value.
    // Targets the outer wrapper div (via :has(), same technique already used
    // for "stories" above) rather than just the <p>, so the flame icon
    // disappears along with the text instead of leaving an orphaned icon.
    selector: 'div:has(> p[title^="Watch Streak" i])'
  },
  discountPromo: {
    label: "Discount promo badge",
    desc: "Hide the \"Discount • Ends in N\" gift-sub promo badge under channels in the sidebar",
    // Direct live DOM capture (right-click > Inspect > Copy outerHTML):
    // <div class="Layout-sc-1xcs6mc-0 dKitkM">
    //   <div role="img" aria-label="Gift Sub" class="Layout-sc-1xcs6mc-0 cHSNzX giftGradient--v_V5Q"></div>
    //   <p class="CoreText-sc-1txzju1-0 jPfhdt">Discount • Ends in 23m</p>
    // </div>
    // Unlike watchStreak above, the <p> here has no title attribute and its
    // text ("Ends in 23m") changes constantly, and CSS has no way to select
    // on plain text content - so this keys off the icon instead, which has
    // two independent identifying signals: aria-label="Gift Sub" (semantic,
    // accessibility-driven, less likely to be a build hash) and a class
    // fragment "giftGradient" (the "--v_V5Q" suffix looks like a per-build
    // hash, but the readable "giftGradient" prefix in front of it is the kind
    // of name CSS-module tooling keeps stable across builds specifically so
    // it stays recognizable). Both are used together via :has() so either
    // one changing independently doesn't break the whole rule. Lower
    // confidence than watchStreak/streamTitle/streamTags above: only one
    // discount variant (gift-sub) has been captured, so a differently-themed
    // discount promo (if Twitch has other kinds) may use a different
    // icon/aria-label this doesn't catch yet.
    selector:
      'div:has(> div[aria-label="Gift Sub"]), div:has(> div[class*="giftGradient"])'
  },
  giftDiscountCallout: {
    label: "Gift sub discount callout",
    desc: "Hide the full \"Limited Time Discount\" promo card with countdown timer",
    // A different, larger element from discountPromo above - that one is the
    // small sidebar badge under a channel's name; this is a full promotional
    // card (title, description, countdown timer, decorative sparkle images)
    // shown elsewhere. Direct live DOM capture (right-click > Inspect > Copy
    // outerHTML) shows the entire card - title text, description, timer, and
    // both sparkle overlays - all nested inside one wrapper carrying class
    // "giftExpirationCalloutCreatorLed--MnvcU". Matched as a substring
    // (ignoring the "--MnvcU" build-hash suffix) directly against that
    // wrapper itself rather than via :has() on some child, since the
    // identifying class lives right on the element that needs hiding this
    // time - one rule removes the whole card in one shot.
    selector: '[class*="giftExpirationCalloutCreatorLed"]'
  },
  subUpsellBanner: {
    label: "Subscribe upsell banner",
    desc: "Hide the \"Subscribe for ad-free viewing, emotes, and more!\" promo card",
    // Direct live DOM capture (right-click > Inspect > Copy outerHTML) - the
    // outer card itself carries an inline style with a semantically-named
    // Twitch CDN asset baked into it:
    // <div style="...background-image: url(\"https://assets.twitch.tv/
    //   assets/sub-upsell-dark-c748577ff1a42c5a2af8.jpg\")...">
    // "sub-upsell" is a fixed, Twitch-owned filename fragment (only the
    // trailing hash varies per asset build), matched as a substring directly
    // against the style attribute's own text - the same technique the
    // "stories" selector above already uses ([style*="margin-top"]).
    //
    // A second alternate here previously read
    // div:has(strong[title^="Subscribe for" i]) - without a > combinator,
    // :has() matches *every* ancestor of a matching descendant, not just the
    // immediate parent. Verified directly (simulated a realistic nested
    // Twitch-shaped DOM: #root > several wrapper divs > ... > this card >
    // the strong) that this matched all 6 ancestor levels including #root
    // itself - since every match gets display:none, that took the entire
    // page down, not just this one card. Removed rather than re-scoped: the
    // strong isn't a direct child of the card (it's nested one level inside
    // a wrapper div), so a >-constrained version wouldn't reach it anyway,
    // and the style-attribute match above is already solid on its own.
    selector: 'div[style*="sub-upsell"]'
  },
  adLearnMoreButton: {
    label: "Ad \"Learn More\" button",
    desc: "Hide the \"Learn More\" call-to-action button shown during video ads",
    // Direct live DOM capture (right-click > Inspect > Copy outerHTML):
    // <button aria-label="Learn more about this ad" class="ScCoreButton-sc-ocjdkq-0 cikFpu">
    // aria-label is a clean, semantic attribute directly on the button
    // itself (no wrapping/:has() needed, unlike several entries above where
    // the identifying signal lived on a child) - same confidence tier as
    // streamTags/streamTitle. Scoped narrowly to just this one button, not a
    // general ad-hiding/ad-blocking feature - that's a materially different
    // (and more policy-sensitive) thing than the cosmetic decluttering the
    // rest of this registry does, and wasn't what was asked for.
    selector: 'button[aria-label="Learn more about this ad"]'
  },
  subDuringAdUpsell: {
    label: "\"Subscribe during ad\" banner",
    desc: "Hide the ad-slot-sized subscribe upsell banner (avatar, sparkles, Subscribe button) shown during ad breaks",
    // Direct live DOM capture (right-click > Inspect > Copy outerHTML):
    // <div aria-label="chan-sda-upsell-third-view" class="Layout-sc-1xcs6mc-0"
    //   style="width: 728px; height: 90px;">
    // 728x90 is the standard IAB "leaderboard" ad size, and every asset
    // filename inside it is prefixed "chan-sub-sda-" (sparkles, sprite) -
    // "sda" reads as "subscribe during ad". The aria-label's "-third-view"
    // suffix strongly implies "-first-view"/"-second-view" siblings exist for
    // earlier impressions in the same session, so this matches the stable
    // "sda-upsell" substring rather than the exact string, to catch all of
    // them with one rule instead of enumerating each view-count variant.
    selector: 'div[aria-label*="sda-upsell" i]'
  },
  celebrations: {
    label: "Celebrations",
    desc: "Hide full-screen celebration animations",
    // Actively wired in FFZ (channel.show-celebrations).
    selector: 'body .celebration__overlay'
  },
  recommendedChannels: {
    label: "Recommended channels",
    desc: "Hide the recommended/popular channels shelf in the sidebar",
    // Actively wired in FFZ (layout.side-nav.show-rec-channels).
    selector:
      '.side-nav .recommended-channels, .side-nav .side-nav-section + .side-nav-section:not(.online-friends):not(.bd--shelf)'
  }
};

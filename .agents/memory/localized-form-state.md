---
name: Localized form state
description: Rules for keeping translated UI and saved form progress from changing or exposing user data.
---

Display translations must be separate from canonical values submitted to APIs. Translate only explicit interface copy; preserve stable option and chip values, and never run broad translation over user, catalog, location, or message data.

**Why:** A broad DOM translation pass can silently turn a valid English enum into a Spanish label before submission, changing matching and admin behavior.

**How to apply:** Give translated controls stable canonical values and read those values rather than visible text. Treat escaped server and user content as data, not translation keys.

Saved form progress must be scoped to the signed-in account, view, and edited entity or conversation. Clear only fields that were successfully committed, plus every draft owned by an account on sign-out.

**Why:** Clearing drafts after every background mutation loses unrelated work, while view-only keys can restore one user's or conversation's text into another.

**How to apply:** Add entity context to draft keys, exclude sensitive and authoritative financial editors, persist only fields the user actually changed, preserve drafts across incidental mutations, and clear only the originating committed fields after success.

Drafts for existing server entities must carry a stable fingerprint of the authoritative values they were based on. Discard the draft with a visible explanation if those values changed elsewhere.

**Why:** Restoring a valid but stale local edit over a newer server value can silently undo changes made from another tab, device, or administrator.

**How to apply:** Capture the entity fingerprint on the first local edit, compare it before every restore, and prefer current server data on a mismatch. Fingerprint only authoritative fields the draft can overwrite; unrelated local mutations must not invalidate the draft. Uploaded request progress may persist authenticated app references, never file contents, and must stay bound to its service.

Controls that rerender their form must persist their canonical selection synchronously. Any deferred delegated saver must ignore a control once it is detached.

**Why:** A queued handler can otherwise read pre-click state from the old DOM after the direct handler has already saved the new value and rerendered.

**How to apply:** Save rerendering selections in their direct handler, and require deferred control references to still be connected before reading them. Server updates for independent form fields should apply atomic field patches rather than stale whole-object merges.
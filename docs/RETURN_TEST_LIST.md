# Tests for when you return

**Sidebar update, 8 November:** Live/History now collapse independently; scrollbar track is transparent; names have muted date/time labels. The search toolbar uses PostgreSQL full-text prefixes, and **+** saves a named, game-selected draft. Draft activation remains a separate next lifecycle step. See [validation](SIDEBAR_DRAFT_VALIDATION.md).

- [ ] Try Live/History collapse with mouse and keyboard, search a name/game or retired status, and clear the search.
- [ ] Use **+**, change game to check its default name, enter a custom name and save a draft. Reload and confirm the name remains in the sidebar. The current live event should remain unchanged.

**Onboarding update, 7 November:** Manage Permissions is now confirmed in both match rooms. Guided setup discovered the actual channels, resumed the same saved event and preserved all 41 events / 408 audit rows. See [onboarding validation](ONBOARDING_VALIDATION.md). Public activation and the four-human flow still need their separate checks.

**7 November status:** [The latest rehearsal record](REHEARSAL_2026_11_07.md) confirms all unit suites, 112 demo browser tests, four native PostgreSQL tests, a real console login/refresh/guard check, and two real player Join/Withdraw cycles with a human-triggered sticky repost. The live roster ended empty. Public-room permissions and the four-human match flow remain pending; the earlier checklist below remains useful for those steps.

14 October 2026. New feature: public match voice rooms, spectator read access and automatic placement of assigned players. Automated verification and live boundaries are recorded in [the validation record](PUBLIC_MATCH_ROOMS_VALIDATION.md): 65 offline tests and both native database cases passed. Public activation and actual voice movement remain pending the permission below and human checks.

## Visuals: quick checks later

- [ ] Double-click **Start TCG Live.bat**: the default browser signs in automatically. Repeat while it is open and confirm there is still one bot/dashboard. Close the browser and relaunch after ten seconds; the bot should remain running and the dashboard reopen.
- [ ] Leave the guided dashboard open or idle overnight; it should remain signed in. Explicit sign-out should still work.
- [ ] Account menu → Game artwork: preview all three defaults, upload/reset banner and thumbnail, choose the active game and Refresh panels. Confirm state colors, mentions and controls remain clear. Repeat Refresh without duplicate image uploads.
- [ ] Try valid PNG/JPEG artwork as well as GIF, and a client with GIF animation disabled. Reject invalid/oversized files with the previous selection intact.

The bot now has 12 original status images/GIFs, inspired by the SysBot state-thumbnail pattern. No need to test these now. When ready:

- [ ] Signup/check-in and both voice panels show one small visual, with no loose duplicate image files after repeated sticky reposts or state changes.
- [ ] Pause remains red, nonfinal orange and final green; image badges agree with the state. The decorative clock animation is not the real deadline.
- [ ] Resume reminders tag only the waiting player and include the bell animation. Successful button clicks stay silent; private errors show their message/artwork and disappear after eight seconds without removing the shared panel.
- [ ] Try a client with GIF animation disabled. Text, mentions, deadline and buttons must remain clear and usable.

See [the visual plan](DISCORD_VISUAL_PLAN.md) and [the artwork overview](../apps/server/assets/discord/visual-contact-sheet.png). Bot uploads need Attach Files as well as Embed Links in each configured channel.

## Permissions and onboarding

The 7 November forced role/channel refresh confirms BoBoAssist now has Manage Permissions in both dedicated match voice rooms. The earlier missing-permission report is resolved; Administrator is unnecessary. The current saved event remains private. Public mode requires a fresh prepared practice session because room mode is frozen with saved routing; previous events and audits remain available.

- [ ] On a first guided start, confirm the dashboard opens and lists the bot's server and available text/voice channels. Existing active-event selections should be locked and preserved.
- [ ] In a separate fresh event, select signup and match rooms, check readiness, and confirm Save and Start creates the panels once. Later healthy startup should open the dashboard directly.
- [ ] When a required permission is genuinely missing, confirm the selected signup channel shows the affected room and repair guide. Rechecking should update the same message without repeated pings. Do not revoke permissions from an active match just to run this check.
- [x] Dashboard artwork upload/preview/reset and active-game selection are implemented. The three supplied defaults preview correctly; actual GIF delivery/reset and unchanged-image retention passed. Continue the client-format and animation checks below.

The existing signup bot can remain usable in private mode meanwhile. Do not expect automatic placement or public room access until the feature is enabled. Turning the setting off later does not restore old room permissions; a one-time local overwrite backup is retained for recovery.

## With your two accounts

Use the owner account as organizer and the other account as an ordinary player/spectator. The owner bypasses Discord channel restrictions, so it cannot prove spectator chat denial.

1. In `tcg-two-player-test`, repeat Join, Withdraw and rejoin. The organizer's Join must say “Signup admin cannot play.” Successful clicks should stay silent; private errors should disappear after about eight seconds.
2. Post a message in signup and both voice-room chats where your account has posting permission. The panel should become the latest message without duplicates or changes to the saved roster.
3. After public mode is enabled, before signup closes, the ordinary account should see and join both voice rooms and read their chats. It should be unable to post. The organizer and bot should still be able to post.
4. Click the public match controls from an unassigned account. They must not start a clock, change a result or move the spectator.

These accounts cannot complete the four-player signup flow with a separate organizer. Do not insert fake accounts into the real signup roster to fill it.

## With four players and the separate organizer

1. Have four accounts Join; note the assigned A/B and C/D identities shown after the organizer closes signup. Each player separately checks in. Publish should be denied until all four do so.
2. While the round is unpublished, assigned players should have chat access only in their own match room. They should not be automatically moved yet. A player from M2 can serve as an ordinary spectator in M1 and vice versa: they can join/read but cannot post or use the other pair's buttons.
3. Put some players in another ordinary server voice channel. Leave one disconnected. Publish the round. Connected players should move to the correct rooms; the disconnected player should stay disconnected.
4. Have that disconnected player join voice later. They should move into their unfinished match's room. Joining the wrong match room should redirect a player once; mute/deafen toggles should cause no new moves. The bot should not pull someone out of the server's AFK channel.
5. Disconnect voluntarily. The bot must not reconnect the player. A spectator should never be moved. Repeatedly switching away is bounded to three move attempts per minute and should produce one organizer warning, not a loop.
6. Play one full match: both Ready, Pause, first green Resume, second Resume, I won, opponent green Agree. Check the remaining-time behavior, targeted waiting-player reminder and green final panel. After final, join another room; automatic placement should no longer redirect those players.
7. Before publication in a fresh practice event, reopen signup after a check-in. Attendance should clear and old player chat grants should disappear. Remove one roster member, join a replacement, close again and verify the new pair's access.
8. Temporarily remove a required bot permission from a task-owned test room, then restore it. The bot should report pending room setup or failed placement honestly. Admin Refresh retries room setup; it must not alter a saved result or award a winner. Do not flood Discord to test rate limits.

For reconnect, expiry, disputes, stale controls and additional failure cases, use [the complete future checklist](FUTURE_TEST_CHECKLIST.md). A persisted running clock still has the existing explicit replacement boundary; this feature does not add clock recovery.

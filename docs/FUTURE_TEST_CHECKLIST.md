# TCG future test checklist

Updated 13 October 2026. The user reported that the latest two-account flow works. The implementation baseline passed 47 offline tests and both native database tests; detailed evidence is in [the validation record](PRIVATE_DISCORD_VALIDATION.md).

The signup slice subsequently passed 53 offline tests and both native database cases. Real signup panels and runtime startup were verified; signup human clicks and the complete four-human flow remain pending. See [signup validation](SIGNUP_ROSTER_VALIDATION.md).

Use the relevant cases after changes. Before inviting more testers, run one complete manual match and the failure cases below. Keep practice results and audit history when resetting a rehearsal.

## Discord regression checks

- [ ] Both accounts check in and Ready. The clock starts only after the second Ready; the panel tags both players.
- [ ] Pause freezes remaining time. The first Resume shows who agreed and tags the waiting opponent; only the second Resume restarts the clock with the correct revised deadline.
- [ ] One targeted resume reminder goes to the missing player per pause. Repeated clicks, sticky reposts, and reconnects do not repeat that notification.
- [ ] Successful buttons create no private success clutter. Private errors disappear after about eight seconds without deleting the shared panel.
- [ ] Only I won is offered for reporting. The opponent can use green Agree or red Dispute; the reporter cannot agree to their own claim. Resume is green and Pause has the orange indicator.
- [ ] An open report blocks another visible win claim. After Dispute, a corrected proposal can be submitted and agreed to. Old revision buttons do not change state.
- [ ] Final panels are green and tag the winner and actual agreeing player. Admin rulings do not falsely name a player as having agreed. Nonfinal panels are orange except paused panels, which are red.
- [ ] The real clock expires without awarding a winner. Judge resolution and correction update the result once, without duplicate points or rating contributions.
- [ ] A human message moves the check-in and each voice-chat panel below it. Test M2 with a real human post as well as M1; bursts produce one current panel, old controls are inert, and bots do not cause repost loops.
- [ ] Click Ready, Resume, and Agree nearly simultaneously from both accounts, including near expiry and while a sticky replacement is in flight. The final card must match the saved state.
- [ ] Delete a task-owned panel or remove a required permission temporarily. Confirm explicit repair, useful errors, and no duplicate automatic sends. Restore permissions afterward; do not deliberately flood Discord to test rate limits.
- [ ] Gateway reconnect preserves current panels and clock behavior. A planned restart from paused state preserves remaining time. A persisted running clock requires the documented explicit replacement rather than guessing elapsed time.

## Signup and roster

- [ ] The organizer cannot Join. A real player can Join, repeat Join without a duplicate entry, Withdraw, and rejoin. The sticky roster tags the correct account without a notification ping.
- [ ] With four real players, simultaneous Join clicks preserve four unique entries. A fifth player gets a private full-roster error; withdrawing opens one slot.
- [ ] Signup Close requires four players and opens separate attendance; it does not automatically check anyone in. A saved old Join button cannot change the closed roster.
- [ ] Publish requires four attendance check-ins. Reopen before publication retains roster, clears attendance and assignment, and returns Join/Withdraw controls. Reopen after publication is denied.
- [ ] Admin Remove releases a slot while signup is open, including for a player who has left the server. A replacement joins at the end of the roster.
- [ ] Restart before publication preserves the roster and its assigned identities. Signup modes reject preset player environment variables; old fixed-roster rehearsal remains usable.
- [ ] Post during signup closure/sticky replacement. The latest panel must show the saved status; successful clicks stay silent and private errors disappear after eight seconds.
- [ ] Assigned voice-chat access and match controls work with four real players and a separate admin. An unregistered user, spectator, or player from another match cannot change a result.

## Next slice: public match rooms and automatic voice placement

Requested 14 October 2026. Implementation passed 65 offline tests and both native database cases; real activation is pending the missing permission and human checks. See [the room plan](PUBLIC_MATCH_ROOMS_PLAN.md), [validation boundaries](PUBLIC_MATCH_ROOMS_VALIDATION.md), and [the ordered return test list](RETURN_TEST_LIST.md). Before enabling it, the owner must give the bot permission to manage channel permission overwrites in both dedicated match rooms. Live preflight found Move Members already available but Manage Roles missing. Do not grant Administrator just for this feature.

- [ ] Ordinary server members can see and join M1/M2 and read their chat, but cannot post. Server owners and Administrator roles bypass channel overwrites; use a normal spectator account for this test.
- [ ] A/B can post only in M1; C/D only in M2. The organizer and bot retain text access in both. Public buttons still reject spectators and players from the other match.
- [ ] Close signup while the round is unpublished. Access reflects the assigned pairs, but players are not moved yet. Attendance check-in remains a separate step.
- [ ] Publish while players are connected to another voice room. Each goes to the correct match room exactly once, with no movement loop.
- [ ] Publish with a player disconnected. They stay disconnected. Joining a voice channel later routes them to their assigned unfinished match.
- [ ] Try the other match room during an unfinished match. The player returns to their assigned room; a spectator is not moved. Mute/deafen changes do not cause new move requests.
- [ ] Disconnect voluntarily. The bot does not reconnect the player. Finish the match, then join another room; the bot no longer redirects that player.
- [ ] Reopen before publication. Previous player chat grants disappear; re-close with a replacement and verify only the new pair receives access.
- [ ] Reconnect/restart with an unpublished or paused practice state. Saved assignment and room policy reconcile without duplicate movement or changes to results/timers. Running-clock restart retains its existing explicit recovery boundary.
- [ ] Temporarily remove Move Members or permission-overwrite management from a task-owned room, then restore it. The bot reports the missing capability and does not claim successful routing or chat restriction. Admin Refresh reconciles after restoration.

The signup implementation is limited to four practice slots with a separate admin. Multiple rounds, tournament pairing, and an admin dashboard remain later work. Real four-player testing remains pending until those accounts are available.

# Public match rooms and automatic player placement

Queued and authorized for implementation on 14 October 2026. Keep the current four-player practice scope and separate organizer.

## Behavior

Everyone in the server can view and join configured match voice rooms. Only the assigned pair, bot and organizer may send messages in each room's text chat. Match buttons continue to authorize the saved pair in both controller and database. Server owners/Administrator roles inherently bypass Discord channel overwrites. Spectator voice speaking is not changed by this slice; the requested restriction applies to the room's text chat and match controls.

After round publication, move already-connected players to the room derived from saved M1=A/B and M2=C/D assignment. If a player is disconnected, do not try to connect them. On a later voice-channel join or wrong-room change, move them to their assigned room while that match is unfinished. Ignore mute/deafen-only changes, spectators, admins and other guilds. Stop redirecting a player after their match is final. Disconnecting remains allowed. Before publication, assigned players can enter rooms themselves but are not redirected.

## Minimal implementation

Opt in with `TCG_DISCORD_PUBLIC_MATCH_ROOMS=1`; require both voice-room IDs, freeze the mode with session routing and retain the existing private default. These are dedicated bot-managed practice rooms: opting in replaces the complete overwrite list for just those configured rooms with everyone View/Connect/ReadHistory and SendMessages denied, explicit bot/admin permissions, and SendMessages for the current pair. This removes stale member and role grants rather than relying on a deny that another role could override. No global role changes, channel deletion, new tables, voice/audio dependency, polling or generic job engine.

One runtime-owned reconciler reuses `getSessionState` and `resolvePlayers`. Serialize calls, reread the latest state when queued work runs, and cache only the successfully applied overwrite plan to avoid repeated writes. Reconcile at startup, committed signup Close/Reopen/Publish, explicit Refresh, reconnect, and relevant voice-state changes. Use GuildVoiceStates intent. Before allowing match interactions, ensure the latest room policy is reconciled; errors retain existing database participant guards and report the exact permission gap. Recheck stop/lease/state before writes/moves. Drain in-flight reconciliation during bounded shutdown. Moves are best effort external effects, never match outcomes or clock commands; no disconnect, no automatic repeated ambiguous move request.

Require Manage Roles for overwrite writes, Move Members for routing, and Connect to targets. Keep user-defined settings outside the two configured rooms unchanged. A failed policy write must not trigger player movement or claim ready. Per-room overwrite replacement is atomic at the Discord endpoint; two rooms are not a cross-service transaction. Surface failures rather than claiming both rooms were updated.

## Alternatives

Editing only the everyone deny is insufficient when another role or old member grant allows chat. Patching individual overwrites requires ownership bookkeeping to remove stale grants. For two dedicated practice rooms, replacing the small complete list is simpler and predictable. Existing rooms remain private until the opted-in policy can be applied safely.

## Validation and live boundary

Test public permission plans, only current pair/admin/bot chat grants, reopen removal, legacy mode/frozen configuration, publication gate, disconnected players, wrong room/rejoin, final matches, unrelated guild/spectator, duplicate events, queue freshness, stop/lease and permission failures. Preserve event/audit history. Native database checks remain separate from mocked Discord effects.

Live preflight found Move Members=true, Manage Channels=true, Manage Roles=false on the bot and both current match rooms. Current everyone View Channel=false. Implement and verify offline now; enabling the public-room policy requires the owner to grant Manage Roles to the bot for these rooms. Do not grant Administrator. Real automatic movement, spectator visibility and chat denial need user-driven voice/client tests after that permission is available.

## Opus review dispositions

Claude Opus 5.5 high effort inspected the text before coding (`.local/private-discord-live/public-rooms-opus-review-final.json`). Its verdict was approve after remedies. These refinements supersede the broader interaction-gating and successful-plan-cache wording above:

- Every policy retains an explicit bot member overwrite including Manage Roles, Manage Channels and Move Members, preventing self-lockout when the owner grants management at channel scope. Require those capabilities before writes. Ask for management permission on the two rooms, not Administrator.
- Validate same-guild distinct voice rooms, exclude the guild AFK channel, and require the dedicated `TCG Match ` name prefix before replacing permissions. Save the original overwrite list once to a local ignored recovery file before the first write; a filesystem failure prevents that write. No new database audit action/table is needed for configuration recovery. Public mode disabled later does not automatically restore privacy.
- Compare current SDK overwrite state to the desired list on every triggered pass. Cache failed plans to prevent repeat writes on every event. Explicit Refresh retries; a changed current/desired policy permits a new attempt.
- Remove the pre-action Discord-write gate. Database authorization protects buttons; the optional room sync runs after committed roster/publication changes and explicit Refresh. Surface a precise room-setup warning if sync fails without rolling back or misreporting a saved match action.
- Use one running pass and one dirty flag, discard unstarted work on shutdown, check stop/lease before each external call, then drain the running pass before destroying the client.
- Treat already-correct destinations as no-ops; ignore AFK and mute-only changes. Add a small per-player three-moves-per-minute cap with one organizer warning. Failed move attempts count and are not blindly retried. Only the configured organizer and bot are exempt; an assigned member with another staff role still follows their match assignment.
- Keep pair chat grants after a final match until the roster changes. Moderator roles without Administrator are not automatically preserved by full overwrite replacement. Spectators are denied new reactions and room slash commands as well as message posting; existing Discord reaction behavior may still permit reacting to an already-present reaction. Participant-only refers to posting and authorized match actions, not hidden public buttons.

The first tools-disabled Claude call mistakenly treated the supplied plan as an implementation request; it is retained as invocation evidence but is not counted as a plan review.

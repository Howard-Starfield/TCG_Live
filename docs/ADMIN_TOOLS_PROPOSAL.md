# Admin Tools Proposal (Carl-bot style)

Status: **proposal, waiting for the organizer's picks.** Nothing here is built yet.

## What already exists
- **Tournament admin:**
  - publish, close/reopen signup, remove a player, resolve, correct, judge-resume
  - available from the `/tcg-test` subcommands and the dashboard console
- **Tournament card stickies:** the bot keeps re-posting its own tournament cards. It has no general sticky messages for other channels.
- **Moderation & evidence:**
  - AutoMod keyword flags
  - voice volume flags and recording
  - match evidence
  - Flags tab
- **Dashboard tabs:** Players, Matches, Audit, Discord (read-only bot panel status), Flags.
- **Missing:**
  - server-wide member search
  - ban list
  - ban/kick/timeout from the dashboard
  - warnings or case log
  - mod notes
  - general sticky messages
  - channel lock or slowmode
- **Intents:** the bot uses no privileged intents (no GuildMembers, no MessageContent).

## Feature menu
Value: H = high, M = medium, L = low. Effort: S = small, M = medium, L = large. **[DUP]** = Discord already has a native version.

### A. Moderation actions
| # | Feature | Value | Effort | Needs | Notes |
|---|---|---|---|---|---|
| 1 | Ban / unban / kick / timeout from the dashboard, reason required | H | S | Ban, Kick, Moderate Members | [DUP] of right-click, but usable from a match card ("ban this no-show"). The bot's role must sit above the target's role. |
| 2 | Warn + case log (numbered cases, reason, moderator, evidence link) | H | M | none (Postgres) | Not native. Links to existing match evidence. |
| 3 | Private mod notes per member | H | S | none | Staff-only. |
| 4 | Tempban / timeout longer than 28 days | M | M | Ban | The PC must be on when it expires; a catch-up job runs on restart. |
| 5 | Mod-action audit trail, including bans done outside the bot | H | S–M | View Audit Log | Merges the server audit log with our cases. |

### B. Member tools
| # | Feature | Value | Effort | Needs | Notes |
|---|---|---|---|---|---|
| 6 | Member quick search + profile (roles, join date, cases, notes, tournament history) | H | S | none (name/prefix search) | Role or join-date filters would need the GuildMembers intent and a local cache (M). |
| 7 | Ban list viewer: search, reason, unban, link to case | H | S | Ban | [DUP] of Server Settings > Bans, which is clumsy at scale. |
| 8 | Bulk role tools ("give Season 3 role to all check-ins") | H | M | Manage Roles | Queued to respect rate limits. |

### C. Channel tools
| # | Feature | Value | Effort | Needs | Notes |
|---|---|---|---|---|---|
| 9 | Sticky messages (rules or "how to report" re-posted at the bottom of a channel) | H | S–M | Send, Manage Messages | Premium-only in Carl-bot. Re-posting is debounced to avoid spam. |
| 10 | Purge by user or count | M | S | Manage Messages | Purge by content needs MessageContent. Messages older than 14 days can't be bulk-deleted. |
| 11 | One-click lock/unlock + slowmode | M | S | Manage Channels | [DUP] of channel settings. Handy during rounds. |
| 12 | Embed / announcement builder | H | M | Send | Not native. |

### D. Logging
| # | Feature | Value | Effort | Needs | Notes |
|---|---|---|---|---|---|
| 13 | Message edit/delete log | M | M | **MessageContent** | Stores message text locally, which raises privacy questions. |
| 14 | Join/leave log + new-account flag | M | S | **GuildMembers** | |
| 15 | Role/nickname change log | L–M | S | GuildMembers | |

### E. Engagement / setup
| # | Feature | Value | Effort | Needs | Notes |
|---|---|---|---|---|---|
| 17 | Button roles (game roles, LFG pings) | H | M | Manage Roles | [DUP-ish] of Discord Onboarding. |
| 18 | Auto-role on join | M | S | GuildMembers | Partly [DUP]. |
| 19 | Welcome/leave messages | M | S | GuildMembers | [DUP-ish]. |
| 20 | Tags / custom commands (`/tag rules`) | M | M | none | |

**Not recommended:** rebuilding keyword AutoMod (already built), anti-raid/verification (Discord's own is better), starboard (low value for a TCG server).

## Recommended MVP: one new "Admin tools" page
1. Member quick search + profile (#6)
2. Ban list + unban (#7)
3. Ban / kick / timeout with a required reason (#1)
4. Warn + case log (#2)
5. Mod notes (#3)
6. Sticky messages (#9)
7. Mod-action audit trail (#5)
8. Lock/unlock + slowmode (#11)

The MVP runs on the bot's current intents and adds only these permissions: Ban, Kick, Moderate Members, Manage Channels, Manage Messages, View Audit Log.

## Decisions (2026-11-14)
- **Building now:**
  - all MVP items (#1, #2, #3, #5, #6, #7, #9, #10, #11)
  - extras: button roles + bulk roles (#8, #17), announcement builder (#12), join/leave + welcome + auto-role (#14, #18, #19), message edit/delete log (#13)
  - a **ticket system** (below)
- **Later:** helper-bot brainstorm, and more feature ideas to propose.
- **Privileged intents are opt-in per feature.**
  - GuildMembers is requested only while join/leave, welcome or auto-role is enabled.
  - MessageContent is requested only while the message log is enabled.
  - The dashboard tells the admin to enable the matching switch in the Developer Portal first. Otherwise Discord rejects the login with "Disallowed intents". If that happens, the bot falls back to starting without the intent and reports it, so it never goes down.
- **Message log:** off by default, with a retention setting, stored locally. Logs can also post to a chosen Discord log channel.
- **Ticket system:**
  - The admin picks a support channel. The bot keeps a sticky "Create ticket" panel there, with a custom emoji, title and text.
  - Clicking the button creates a private channel `ticket-<name>-<n>` under a chosen category. Only the member, the chosen staff roles and the bot can see it.
  - Each member can have one open ticket.
  - A Close button (member or staff) saves a transcript to Postgres, readable in the dashboard, then deletes the channel. Staff can reopen a ticket from the dashboard within 24 h.
  - Ticket actions are written to the audit trail.

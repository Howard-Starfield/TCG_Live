// What the bot and the dashboard can do, as typed data: one entry per capability, grouped by area. The
// Capabilities & shortcuts page renders and searches this list; `status` keys are resolved live in status.ts.
// Entries marked `wave: 'next'` were added in this release and show a "New" badge.

export const CAPABILITY_AREAS = ['Tournament', 'Evidence', 'Moderation & voice', 'Admin tools', 'LFG', 'Bots', 'Setup & permissions'] as const;
export type CapabilityArea = typeof CAPABILITY_AREAS[number];

/** A dashboard place an entry links to. */
export type CapabilityLink =
  | { page: 'home' }
  | { page: 'drafts' }
  | { page: 'event' }
  | { page: 'admin-tools'; tab?: string }
  | { page: 'capabilities' };

export type CapabilityWhere =
  /** A slash command, written exactly as typed in Discord. */
  | { kind: 'command'; syntax: string }
  /** A button or form on a Discord message the bot posts. */
  | { kind: 'button'; label: string; on: string }
  /** Something the bot does by itself. */
  | { kind: 'automatic'; detail: string }
  /** A dashboard place; `link` makes it clickable. */
  | { kind: 'dashboard'; path: string; link?: CapabilityLink };

/**
 * Live status checks, resolved by capabilityStatus():
 * - dashboard-actions: the session may run dashboard actions (the "Allow dashboard actions" switch / TCG_ADMIN_COMMANDS)
 * - tournaments / evidence / moderation / admin-tools / demo: the runtime mounted that feature for this session
 * - voice-monitor / recording: the moderation settings turn voice loudness / recording on
 * - intent:<name>: a privileged intent is on in the Developer Portal
 * - perm:<prefix>: no open permission issue whose featureId starts with the prefix
 */
export type CapabilityCheck =
  | 'dashboard-actions' | 'tournaments' | 'evidence' | 'moderation' | 'admin-tools' | 'demo'
  | 'voice-monitor' | 'recording'
  | 'intent:guildMembers' | 'intent:messageContent'
  | `perm:${string}`;

export interface CapabilityEntry {
  id: string;
  area: CapabilityArea;
  name: string;
  /** What it does, in one or two sentences. */
  what: string;
  where: CapabilityWhere[];
  /** Who can use it: players, tournament staff roles, the admin, or a dashboard capability. */
  who: string;
  /** Discord permission or intent the bot needs, as Discord names it. */
  needs?: string;
  checks?: CapabilityCheck[];
  /** Added in this release ("New" badge). */
  wave?: 'next';
}

const ADMIN = 'Admin (dashboard)';
/** /tcg-staff: Discord shows it to everyone; the bot checks the TCG Organizer and TCG Judge roles (the server owner counts as organizer). */
const STAFF = 'TCG Organizer (and the server owner). TCG Judge cannot use it.';
const JUDGE = 'TCG Organizer or TCG Judge (and the server owner), but not on a match they are playing in.';
const JUDGE_ANY = 'TCG Organizer or TCG Judge (and the server owner).';
const EVENT: CapabilityLink = { page: 'event' };
const tab = (id: string): CapabilityLink => ({ page: 'admin-tools', tab: id });

export const CAPABILITIES: readonly CapabilityEntry[] = [
  // ---------------------------------------------------------------- Tournament
  { id: 'tcg-staff-command', area: 'Tournament', name: 'Staff command (/tcg-staff)', what: 'Tournament staff tools in Discord: publish, signup changes, check in for a player, refresh, resolve, correct, judge-resume, judge-close and evidence-reply. Match and player options autocomplete from the live round. The command is visible to everyone in Discord; the bot checks your role and refuses anyone without one. The old /tcg-test form of these subcommands is still accepted.',
    where: [{ kind: 'command', syntax: '/tcg-staff <subcommand>' }, { kind: 'dashboard', path: 'Admin tools > Settings > Tournament roles', link: tab('settings') }],
    who: 'Per subcommand: organizer-only for publish, signup changes and refresh; judges may also check in, resolve, correct, judge-resume, judge-close and reply to evidence', wave: 'next' },
  { id: 'tcg-refresh', area: 'Tournament', name: 'Refresh the cards', what: 'Creates or repairs the signup and match cards in the tournament channel.',
    where: [{ kind: 'command', syntax: '/tcg-staff refresh' }, { kind: 'dashboard', path: 'Event > composer: /refresh', link: EVENT }],
    who: STAFF, needs: 'View Channel, Send Messages, Embed Links, Read Message History', checks: ['perm:tournament.signup'] },
  { id: 'tcg-publish', area: 'Tournament', name: 'Publish the round', what: 'Publishes the pairings so players see their match cards.',
    where: [{ kind: 'command', syntax: '/tcg-staff publish' }, { kind: 'dashboard', path: 'Event > composer: /publish', link: EVENT }],
    who: STAFF, checks: ['dashboard-actions'] },
  { id: 'tcg-signup-close', area: 'Tournament', name: 'Close signup', what: 'Closes signup and seats the signed-up members.',
    where: [{ kind: 'command', syntax: '/tcg-staff signup-close' }, { kind: 'dashboard', path: 'Event > composer: /signup-close', link: EVENT }], who: STAFF },
  { id: 'tcg-signup-reopen', area: 'Tournament', name: 'Reopen signup', what: 'Reopens signup before the round is published.',
    where: [{ kind: 'command', syntax: '/tcg-staff signup-reopen' }, { kind: 'dashboard', path: 'Event > composer: /signup-reopen', link: EVENT }], who: STAFF },
  { id: 'tcg-signup-remove', area: 'Tournament', name: 'Remove a signup', what: 'Removes one member from an open signup.',
    where: [{ kind: 'command', syntax: '/tcg-staff signup-remove member-id:<Discord ID>' }, { kind: 'dashboard', path: 'Event > Players tab > Remove', link: EVENT }],
    who: STAFF },
  { id: 'tcg-signup-add', area: 'Tournament', name: 'Add a player to signup', what: 'An organizer adds a member to the open signup on their behalf. The organizer can be added too: organizers may play.',
    where: [{ kind: 'command', syntax: '/tcg-staff signup-add member:<@member>' }, { kind: 'dashboard', path: 'Event > composer: /signup-add', link: EVENT }],
    who: STAFF, wave: 'next' },
  { id: 'tcg-checkin-for', area: 'Tournament', name: 'Check in for a player', what: 'Checks a seated player in on their behalf (a seat such as A or P3, or a mention).',
    where: [{ kind: 'command', syntax: '/tcg-staff checkin-for player:<seat or @member>' }, { kind: 'dashboard', path: 'Event > composer: /checkin-for', link: EVENT }],
    who: JUDGE_ANY, wave: 'next' },
  { id: 'tcg-resolve', area: 'Tournament', name: 'Resolve a match', what: 'Decides a match winner with a required reason (disputes, expired clocks).',
    where: [{ kind: 'command', syntax: '/tcg-staff resolve match:<M1> winner:<seat> reason:<text>' }, { kind: 'dashboard', path: 'Event > Needs you / Matches tab > Resolve', link: EVENT }],
    who: JUDGE, checks: ['dashboard-actions'] },
  { id: 'tcg-correct', area: 'Tournament', name: 'Correct a result', what: 'Changes the winner of a finished match, with a reason.',
    where: [{ kind: 'command', syntax: '/tcg-staff correct match:<M1> winner:<seat> reason:<text>' }, { kind: 'dashboard', path: 'Event > Matches tab > Correct', link: EVENT }],
    who: JUDGE, checks: ['dashboard-actions'] },
  { id: 'tcg-judge-close', area: 'Tournament', name: 'Close a judge call', what: 'Closes a plain judge call with a note, without choosing a winner.',
    where: [{ kind: 'command', syntax: '/tcg-staff judge-close match:<M1> note:<text>' }, { kind: 'dashboard', path: 'Event > Needs you > Close issue', link: EVENT }],
    who: JUDGE, checks: ['dashboard-actions'], wave: 'next' },
  { id: 'tcg-evidence-reply', area: 'Tournament', name: 'Reply to match evidence', what: 'Answers on the evidence thread of a match; the reply is delivered to the seated players, or kept staff-only.',
    where: [{ kind: 'command', syntax: '/tcg-staff evidence-reply match:<M1> text:<text> staff-only:<true|false>' }, { kind: 'dashboard', path: 'Event > Matches tab > Evidence', link: EVENT }],
    who: JUDGE, checks: ['evidence'], wave: 'next' },
  { id: 'tcg-judge-resume', area: 'Tournament', name: 'Resume after a judge call', what: 'Ends a judge pause and restarts the match clock.',
    where: [{ kind: 'command', syntax: '/tcg-staff judge-resume match:<M1> reason:<text>' }, { kind: 'dashboard', path: 'Event > Needs you > Resume', link: EVENT }],
    who: JUDGE, checks: ['dashboard-actions'] },
  { id: 'signup-card', area: 'Tournament', name: 'Signup card', what: 'Players join or withdraw, check in, and anyone can view the roster (CSV). While recording is on, the card states the recording policy and how to opt out.',
    where: [{ kind: 'button', label: 'Join · Withdraw · Check in · View roster', on: 'the signup card' }], who: 'Everyone in the channel; check-in for signed-up players',
    needs: 'Send Messages, Embed Links, Pin Messages (optional)', checks: ['perm:tournament.'] },
  { id: 'match-card', area: 'Tournament', name: 'Match card', what: 'Players mark ready, pause and resume, report "I won", agree or disagree, and call a judge with a short form. "🔴 Audio recording active" shows while the room is recorded.',
    where: [{ kind: 'button', label: 'Ready · Pause · Resume · I won · Agree · Disagree · Call judge', on: 'each match card' }], who: 'The two seated players' },
  { id: 'match-card-evidence', area: 'Tournament', name: 'Submit evidence button', what: 'Opens a form on the match card for a clip link or note. Shown while a judge is needed or a result is disputed, and for 24 hours after the result.',
    where: [{ kind: 'button', label: 'Submit evidence', on: 'each match card' }], who: 'The two seated players, TCG Organizer and TCG Judge', checks: ['evidence'], wave: 'next' },
  { id: 'home-directory', area: 'Tournament', name: 'Tournament directory', what: 'Search, create (from templates) and delete tournaments; drafts list pending ones.',
    where: [{ kind: 'dashboard', path: 'Home', link: { page: 'home' } }, { kind: 'dashboard', path: 'Sidebar > Drafts', link: { page: 'drafts' } }],
    who: ADMIN, checks: ['tournaments'] },
  { id: 'signup-timing', area: 'Tournament', name: 'Signup opening, timers and Delay start', what: 'Schedule when signup opens, set the match timer and delay the start of a draft.',
    where: [{ kind: 'dashboard', path: 'Drafts > a draft > details', link: { page: 'drafts' } }], who: ADMIN, checks: ['tournaments'] },
  { id: 'live-flow', area: 'Tournament', name: 'Live flow and Needs-you queue', what: 'Follow every match as it happens; disputes, judge calls and expired clocks queue up for you.',
    where: [{ kind: 'dashboard', path: 'Event > Live preview (Alt+1) · Needs you', link: EVENT }], who: ADMIN },
  { id: 'event-lists', area: 'Tournament', name: 'Players, Matches, Audit, Discord and Flags tabs', what: 'Tables for the event: players, matches with evidence, the command audit (export CSV/JSON), Discord panel state and flags.',
    where: [{ kind: 'dashboard', path: 'Event > List preview (Alt+2)', link: EVENT }], who: ADMIN },
  { id: 'composer', area: 'Tournament', name: 'Command composer', what: 'Type the staff commands with autocomplete: "/" for commands, "@" for members. A pasted /tcg-staff or /tcg-test command also works.',
    where: [{ kind: 'dashboard', path: 'Event > composer', link: EVENT }], who: ADMIN, checks: ['dashboard-actions'] },
  { id: 'artwork', area: 'Tournament', name: 'Game artwork', what: 'Pick the game whose artwork the cards and banners use.',
    where: [{ kind: 'dashboard', path: 'Account menu > Game artwork…' }], who: ADMIN },
  { id: 'demo', area: 'Tournament', name: 'Run tournament demo', what: 'Opens a practice console with 5, 8, 9 or 100 synthetic players. Nothing touches Discord.',
    where: [{ kind: 'dashboard', path: 'Account menu > Run tournament demo' }], who: ADMIN, checks: ['demo'] },

  // ---------------------------------------------------------------- Evidence
  { id: 'evidence-command', area: 'Evidence', name: 'Submit evidence from Discord', what: 'Attach a clip (up to 100 MB) or a link with a note to your match.',
    where: [{ kind: 'command', syntax: '/tcg-test evidence match:<M1> file:<attachment> link:<https://…> note:<text>' }],
    who: 'Seated players, TCG Organizer and TCG Judge', needs: 'Attach Files on the player side; none extra for the bot', checks: ['evidence'] },
  { id: 'evidence-drawer', area: 'Evidence', name: 'Evidence drawer', what: 'Upload files (with progress and time left; leaving the page warns while an upload runs) or links, hold, delete with a reason, play or download; copy an item ID or attach it to a case.',
    where: [{ kind: 'dashboard', path: 'Event > Matches tab > Evidence', link: EVENT }], who: 'Dashboard: evidence.read to view, evidence.manage to change',
    checks: ['evidence'] },
  { id: 'case-evidence', area: 'Evidence', name: 'Evidence on cases', what: 'Pick evidence when you warn, time out, kick or ban, or attach an item to an existing case (up to 10 per case).',
    where: [{ kind: 'dashboard', path: 'Admin tools > Cases', link: tab('cases') }, { kind: 'dashboard', path: 'Event > Matches tab > Evidence > Attach to case', link: EVENT }],
    who: 'Dashboard: members.moderate', checks: ['admin-tools', 'evidence'], wave: 'next' },

  // ---------------------------------------------------------------- Moderation & voice
  { id: 'moderation-dialog', area: 'Moderation & voice', name: 'Moderation & evidence settings', what: 'AutoMod keyword lists with Sync, volume flags, recording modes and opt-outs, retention and the notice text.',
    where: [{ kind: 'dashboard', path: 'Sidebar or Account menu > Moderation & evidence…' }], who: 'Dashboard: moderation.manage', needs: 'Manage Server (AutoMod), Timeout Members',
    checks: ['moderation', 'perm:automod.'] },
  { id: 'flags', area: 'Moderation & voice', name: 'Flags', what: 'AutoMod keyword hits and loud voice moments; acknowledge, dismiss or reopen, filter by review state, moderate the member, export CSV/JSON.',
    where: [{ kind: 'dashboard', path: 'Event > List preview > Flags', link: EVENT }], who: 'Dashboard: moderation.manage', checks: ['moderation'] },
  { id: 'ops-audit', area: 'Moderation & voice', name: 'Evidence & moderation audit', what: 'Every evidence and moderation change, with export.',
    where: [{ kind: 'dashboard', path: 'Event > Audit tab > Evidence & moderation', link: EVENT }], who: 'Dashboard: evidence.read', checks: ['moderation'] },
  { id: 'voice-rooms', area: 'Moderation & voice', name: 'Voice monitoring in match rooms', what: 'The bots join match voice rooms, the main bot posts a notice, and sustained loud moments are flagged. Nobody is muted.',
    where: [{ kind: 'automatic', detail: 'joins covered match rooms' }], who: 'Automatic', needs: 'View Channel, Connect, Send Messages',
    checks: ['voice-monitor', 'perm:voice.'] },
  { id: 'voice-recording', area: 'Moderation & voice', name: 'Voice recording', what: 'Records each player to their own Ogg file as match evidence (audio only). Match cards show "🔴 Audio recording active" while it runs.',
    where: [{ kind: 'automatic', detail: 'per-player Ogg recordings' }], who: 'Automatic', needs: 'View Channel, Connect', checks: ['recording', 'perm:voice.'] },
  { id: 'recording-optout', area: 'Moderation & voice', name: 'Recording opt-out', what: 'A player opts out of (or back into) recording; opted-out players are never recorded or loudness-checked. Staff see and edit the list.',
    where: [{ kind: 'command', syntax: '/tcg-test recording-optout choice:<Opt out | Opt back in>' }, { kind: 'dashboard', path: 'Moderation & evidence… > Recording > Players who opted out' }],
    who: 'Any player; the list: moderation.manage', wave: 'next' },
  { id: 'tcg-admin-moderation', area: 'Moderation & voice', name: 'Moderate from Discord (/tcg-admin)', what: 'Warn, time out, lift a timeout, kick, ban (give a duration for a temporary ban) and unban; each opens a numbered case. Look up a case or add a private note.',
    where: [{ kind: 'command', syntax: '/tcg-admin warn|timeout|untimeout|kick|ban member:<@member> reason:<text>' },
      { kind: 'command', syntax: '/tcg-admin ban member:<@member> reason:<text> duration:<1d>' },
      { kind: 'command', syntax: '/tcg-admin unban user-id:<Discord ID> reason:<text>' },
      { kind: 'command', syntax: '/tcg-admin case number:<n>' }, { kind: 'command', syntax: '/tcg-admin note member:<@member> text:<note>' }], who: 'TCG Organizer, plus members with the Discord permission each action needs. TCG Judge cannot moderate.',
    needs: 'Timeout Members, Kick Members, Ban Members', checks: ['perm:members.'], wave: 'next' },
  { id: 'moderate-member', area: 'Moderation & voice', name: 'Moderate member (dashboard)', what: 'Warn, time out, kick, ban or temporary ban (with evidence) from the Players and Matches tabs, Needs-you cards, Flags, the Evidence drawer and member profiles.',
    where: [{ kind: 'dashboard', path: 'Event > Players / Matches / Flags', link: EVENT }, { kind: 'dashboard', path: 'Admin tools > Members', link: tab('members') }],
    who: 'Dashboard: members.moderate', checks: ['admin-tools', 'perm:members.'] },

  // ---------------------------------------------------------------- Admin tools
  { id: 'at-members', area: 'Admin tools', name: 'Members', what: 'Search members, open profiles with cases, notes and tournament history.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Members', link: tab('members') }], who: 'Dashboard: members.read', checks: ['admin-tools'] },
  { id: 'at-bans', area: 'Admin tools', name: 'Bans', what: 'The server ban list with unban.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Bans', link: tab('bans') }], who: 'Dashboard: members.read to view, members.moderate to unban', needs: 'Ban Members', checks: ['admin-tools', 'perm:members.ban'] },
  { id: 'at-cases', area: 'Admin tools', name: 'Cases', what: 'Numbered cases with reason and evidence, the mod-action audit trail, CSV/JSON export.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Cases', link: tab('cases') }], who: 'Dashboard: members.read', needs: 'View Audit Log (optional)', checks: ['admin-tools'] },
  { id: 'at-channels', area: 'Admin tools', name: 'Channels', what: 'Create text channels and voice rooms; lock, unlock, slowmode and purge channels.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Channels', link: tab('channels') }], who: 'Dashboard: members.moderate, server.manage to create', needs: 'Manage Roles, Manage Channels, Manage Messages', checks: ['admin-tools', 'perm:channels.'] },
  { id: 'at-stickies', area: 'Admin tools', name: 'Stickies', what: 'Messages the bot keeps at the bottom of a channel.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Stickies', link: tab('stickies') }], who: 'Dashboard: server.manage', checks: ['admin-tools', 'perm:stickies.'] },
  { id: 'at-tickets', area: 'Admin tools', name: 'Tickets', what: 'A Create ticket panel, private ticket channels, transcripts (export) with close and reopen.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Tickets', link: tab('tickets') }, { kind: 'button', label: 'Create ticket', on: 'the support channel panel' }],
    who: 'Members open; staff roles answer; dashboard: members.read', needs: 'Manage Channels, Message Content intent for full transcripts', checks: ['admin-tools', 'perm:tickets.'] },
  { id: 'at-roles', area: 'Admin tools', name: 'Roles', what: 'Button-role panels and bulk role changes for tournament players.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Roles', link: tab('roles') }], who: 'Dashboard: server.manage', needs: 'Manage Roles', checks: ['admin-tools', 'perm:roles.'] },
  { id: 'at-announcements', area: 'Admin tools', name: 'Announcements', what: 'Compose, preview and schedule announcements with role pings (and opt-in @everyone).',
    where: [{ kind: 'dashboard', path: 'Admin tools > Announcements', link: tab('announcements') }], who: 'Dashboard: server.manage', checks: ['admin-tools', 'perm:announcements.'] },
  { id: 'at-logs', area: 'Admin tools', name: 'Logs, welcome and auto-role', what: 'Join/leave and message logs (export), welcome messages and auto-roles with a Skip bots switch.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Logs', link: tab('logs') }], who: 'Dashboard: members.read; server.manage to change',
    needs: 'Server Members intent; Message Content intent for the message log', checks: ['admin-tools', 'intent:guildMembers', 'perm:logging.'] },
  { id: 'at-settings', area: 'Admin tools', name: 'Admin tools settings', what: 'Bot permissions, the bot setup guide, case DMs, the case log channel and the tournament roles (TCG Organizer and TCG Judge).',
    where: [{ kind: 'dashboard', path: 'Admin tools > Settings', link: tab('settings') }], who: 'Dashboard: members.read; server.manage to change', checks: ['admin-tools'] },
  { id: 'staff-roles', area: 'Admin tools', name: 'Tournament roles', what: 'The bot-managed TCG Organizer and TCG Judge roles: create, rename, recolour and choose who holds them. Organizers can do every staff action; judges rule on matches, check players in and handle evidence, and neither may rule on a match they play in. /tcg-staff is visible to everyone and the bot enforces the roles. Each action records who did it. Roles from the older staff-roles setting count as TCG Judge.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Settings > Tournament roles', link: tab('settings') }], who: 'Dashboard: server.manage',
    checks: ['admin-tools'], wave: 'next' },
  { id: 'tcg-admin-status', area: 'Admin tools', name: 'Admin tools status in Discord', what: 'Shows privileged intents and restart notices.',
    where: [{ kind: 'command', syntax: '/tcg-admin status' }], who: 'Members with Manage Server, or roles allowed in Server Settings > Integrations' },
  { id: 'exports', area: 'Admin tools', name: 'Exports (CSV / JSON)', what: 'Download cases, logs, ticket transcripts, flags and audits. Every page is fetched up to a cap (the file says when it was cut short), and cells that a spreadsheet would run as formulas are neutralised.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Cases', link: tab('cases') }, { kind: 'dashboard', path: 'Admin tools > Logs', link: tab('logs') },
      { kind: 'dashboard', path: 'Event > Audit / Flags tabs', link: EVENT }], who: 'Dashboard: members.read or evidence.read', wave: 'next' },
  { id: 'deep-links', area: 'Admin tools', name: 'Deep links', what: 'The address bar keeps the page, tab and open item (#/admin-tools/<tab>, #/admin-tools/cases/12, #/capabilities), so a reload or a bookmark reopens it.',
    where: [{ kind: 'automatic', detail: 'the address bar follows Admin tools and this page' }], who: ADMIN, wave: 'next' },

  // ---------------------------------------------------------------- LFG
  { id: 'lfg-panel', area: 'LFG', name: 'Looking for a game panel', what: 'A sticky button in each LFG channel opens a form: game, format, note and an optional voice room.',
    where: [{ kind: 'button', label: 'Looking for a game', on: 'the LFG channel panel (text, label and emoji can be changed)' }], who: 'Everyone in the LFG channels', needs: 'Send Messages, Embed Links', wave: 'next' },
  { id: 'lfg-card', area: 'LFG', name: 'LFG cards', what: 'Each request posts a card with Join and Leave and the list of who joined; an optional role ping with a cooldown; the card closes itself after the set time.',
    where: [{ kind: 'button', label: 'Join · Leave · Close', on: 'each LFG card' }], who: 'Everyone in the LFG channels; Close for the poster and members with Manage Messages', wave: 'next' },
  { id: 'lfg-settings', area: 'LFG', name: 'LFG settings, posts and stats', what: 'Choose LFG channels, games, formats, the ping role and cooldown, the auto-close time and every message text with a live preview; post or refresh the panels; close or delete posts; stats per game.',
    where: [{ kind: 'dashboard', path: 'Admin tools > LFG', link: tab('lfg') }], who: 'Dashboard: members.read to view, server.manage to change settings, members.moderate to close posts',
    checks: ['admin-tools'], wave: 'next' },

  // ---------------------------------------------------------------- Bots
  { id: 'helper-bots', area: 'Bots', name: 'Helper bots', what: 'Extra bot applications you own cover more voice rooms at once (audio only). Add a helper with the guided wizard; Verify, Retry, Replace token, copy the invite link, enable or remove.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Bots', link: tab('bots') }], who: 'Dashboard: moderation.manage', needs: 'View Channel, Connect (helpers only)',
    checks: ['moderation'], wave: 'next' },
  { id: 'helper-nicknames', area: 'Bots', name: 'Helper nicknames', what: 'Give each helper a server nickname (for example TCG Recorder 2) so players see which bot records them.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Bots > Nickname in this server', link: tab('bots') }], who: 'Dashboard: moderation.manage',
    checks: ['moderation'], wave: 'next' },
  { id: 'capacity', area: 'Bots', name: 'Capacity banner', what: 'Rooms against bots: how many rooms would go unmonitored, and the disk an hour of recording takes against the evidence quota.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Bots', link: tab('bots') }], who: 'Dashboard: moderation.manage', checks: ['moderation'], wave: 'next' },
  { id: 'room-settings', area: 'Bots', name: 'Per-room settings', what: 'Per match voice room: coverage (auto, always, never), recording, priority and a pinned bot. Kept by voice channel, so they carry over between events.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Bots > Match rooms', link: tab('bots') }], who: 'Dashboard: moderation.manage', checks: ['moderation'], wave: 'next' },

  // ---------------------------------------------------------------- Setup & permissions
  { id: 'setup-wizard', area: 'Setup & permissions', name: 'Setup wizard', what: 'Pick the server, channels and admin (or create a missing text channel or voice room), choose the dashboard options, check readiness and finish the first start.',
    where: [{ kind: 'dashboard', path: 'First start' }], who: ADMIN },
  { id: 'permission-checker', area: 'Setup & permissions', name: 'Permission checker and grant link', what: 'Lists what the bot is missing and why, with an invite link that grants it.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Settings > Bot permissions', link: tab('settings') }], who: ADMIN, checks: ['admin-tools', 'perm:'] },
  { id: 'bot-setup-guide', area: 'Setup & permissions', name: 'Bot setup guide', what: 'Step-by-step Developer Portal settings: intents, invite and roles.',
    where: [{ kind: 'dashboard', path: 'Admin tools > Settings > Bot setup guide', link: tab('settings') }], who: ADMIN },
  { id: 'intents', area: 'Setup & permissions', name: 'Privileged intents', what: 'Server Members (logs, welcome, auto-role) and Message Content (message log, full transcripts) are turned on in the Developer Portal.',
    where: [{ kind: 'automatic', detail: 'requested only while a feature needs them' }], who: ADMIN, needs: 'Server Members intent, Message Content intent',
    checks: ['intent:guildMembers', 'intent:messageContent'] },
  { id: 'dashboard-actions', area: 'Setup & permissions', name: 'Allow dashboard actions', what: 'Lets this dashboard run tournament actions and server tools (publish, resolve, correct…), like TCG_ADMIN_COMMANDS=1. On by default and applies at once; a banner explains when it is off.',
    where: [{ kind: 'dashboard', path: 'Sidebar > Dashboard options' }, { kind: 'dashboard', path: 'Setup wizard > Dashboard options' }, { kind: 'dashboard', path: 'This page > Quick switches' }],
    who: ADMIN, checks: ['dashboard-actions'], wave: 'next' },
  { id: 'voice-switch', area: 'Setup & permissions', name: 'Voice monitoring switch', what: 'Turns the voice bots on or off, like TCG_DISCORD_VOICE=1. Applies after a restart; a banner reminds you.',
    where: [{ kind: 'dashboard', path: 'Sidebar > Dashboard options' }, { kind: 'dashboard', path: 'Setup wizard > Dashboard options' }, { kind: 'dashboard', path: 'This page > Quick switches' }],
    who: ADMIN, wave: 'next' },
  { id: 'account-menu', area: 'Setup & permissions', name: 'Account menu', what: 'Theme, rotate the console link, sign out, and this page.',
    where: [{ kind: 'dashboard', path: 'Account menu (top right / sidebar bottom)' }], who: ADMIN },
  { id: 'capabilities-page', area: 'Setup & permissions', name: 'This page', what: 'This page: what the bot and the dashboard can do, with live status. Press ? anywhere (not while typing or in a dialog) for the shortcuts.',
    where: [{ kind: 'dashboard', path: 'Sidebar > Capabilities', link: { page: 'capabilities' } }], who: ADMIN, wave: 'next' }
];

export interface ShortcutEntry { keys: string[][]; what: string; where: string; wave?: 'next' }

/** Every keyboard shortcut in the dashboard. Each inner array is one key combination; alternatives are listed side by side. */
export const SHORTCUTS: readonly ShortcutEntry[] = [
  { keys: [['?']], what: 'Show keyboard shortcuts', where: 'Anywhere (not while typing or in a dialog)', wave: 'next' },
  { keys: [['Alt', '1']], what: 'Toggle the Live preview', where: 'Event view' },
  { keys: [['Alt', '2']], what: 'Toggle the List preview', where: 'Event view' },
  { keys: [['/']], what: 'Start a command', where: 'Command composer' },
  { keys: [['@']], what: 'Mention a member', where: 'Command composer' },
  { keys: [['↑'], ['↓']], what: 'Move through suggestions', where: 'Command composer' },
  { keys: [['Enter'], ['Tab']], what: 'Accept the suggestion (Enter runs a complete command)', where: 'Command composer' },
  { keys: [['Esc']], what: 'Close the suggestions', where: 'Command composer' },
  { keys: [['Ctrl', 'Enter'], ['⌘', 'Enter']], what: 'Confirm', where: 'Dialogs that ask for a reason' },
  { keys: [['Esc']], what: 'Close the dialog or drawer', where: 'Dialogs, drawers, menus' },
  { keys: [['Enter'], [',']], what: 'Add the typed word', where: 'Keyword chip inputs' },
  { keys: [['Backspace']], what: 'Remove the last word when the input is empty', where: 'Keyword chip inputs' },
  { keys: [['←'], ['→'], ['↑'], ['↓']], what: 'Resize the preview panes', where: 'Preview divider (focused)' },
  { keys: [['Home'], ['End']], what: 'Collapse a preview pane to its minimum or maximum', where: 'Preview divider (focused)' },
  { keys: [['Enter'], ['Space']], what: 'Open the match', where: 'Live flow nodes' },
  { keys: [['Enter']], what: 'Open the row (match, audit entry)', where: 'Tables' }
];

/** Lower-case search text of an entry: name, description, where, who, needs and area ("new" for this release's entries). */
export function capabilityText(entry: CapabilityEntry): string {
  const where = entry.where.map(item => item.kind === 'command' ? item.syntax : item.kind === 'button' ? `${item.label} ${item.on}`
    : item.kind === 'automatic' ? item.detail : item.path).join(' ');
  return `${entry.name} ${entry.what} ${where} ${entry.who} ${entry.needs ?? ''} ${entry.area} ${entry.wave ? 'new' : ''}`.toLocaleLowerCase();
}

/** Entries whose text contains every word of the query (case-insensitive). */
export function filterCapabilities(entries: readonly CapabilityEntry[], query: string): CapabilityEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter(entry => { const text = capabilityText(entry); return words.every(word => text.includes(word)); });
}

export function filterShortcuts(entries: readonly ShortcutEntry[], query: string): ShortcutEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter(entry => {
    const text = `${entry.what} ${entry.where} ${entry.keys.flat().join(' ')} shortcut keyboard`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

import type { SetupCapabilityDto, SetupChannelCreateDto, SetupChannelDto, SetupCheckDto, SetupFinishDto, SetupGuildDto,
  SetupMatchRoomsDto, SetupSelectionDto, SetupStatusDto, TournamentRolesEnsureResultDto } from '@tcg-live/core';
import type { MatchRoomSetupSink } from '../admin-tools/match-rooms/service-port.js';
import { profileTournamentRoleStore, type TournamentRoleStore } from '../admin-tools/tournament-roles/store.js';
import { HttpError } from '../admin/http/respond.js';
import { type PrivateDiscordConfig, sameIdentityMap } from '../discord/config.js';
import type { SessionRow } from '../discord/session.js';
import { SetupProfileStore, validSelection, type SetupProfile } from './profile.js';
import { setupPermissionReport } from '../permissions/setup.js';
import { SETUP_CHANNEL_PERMISSIONS, SETUP_ROOMS_BLOCKING, SETUP_ROOMS_PERMISSIONS } from '../permissions/table.js';

export const SETUP_GUIDE = 'Server Settings → Roles → the bot role → turn on the missing permissions (Manage Channels, Manage Roles, '
  + 'Move Members and the rest of the list) → Save Changes. No per-channel Manage Permissions overwrite is needed.';
// One source of truth: the permission table in permissions/table.ts.
const TEXT: readonly string[] = SETUP_CHANNEL_PERMISSIONS.text;
const VOICE: readonly string[] = SETUP_CHANNEL_PERMISSIONS.voice;
const PUBLIC: readonly string[] = SETUP_CHANNEL_PERMISSIONS.public;
const ROOMS: readonly string[] = SETUP_ROOMS_PERMISSIONS;

export interface DiscoveredChannel extends SetupChannelDto { permissions: string[]; afk: boolean }
export interface SetupDiscovery {
  readonly applicationId: string;
  readonly botName: string;
  guilds(): Promise<SetupGuildDto[]>;
  channels(guildId: string): Promise<DiscoveredChannel[]>;
  /** Creates a top-level text or voice channel; `name` is already validated. */
  createChannel(guildId: string, name: string, type: 'text' | 'voice'): Promise<DiscoveredChannel>;
  /** Creates once or edits an owned guide; `missing` is already validated. */
  guide(channelId: string, adminId: string, content: string, messageId: string | null,
    mentionAdmin: boolean): Promise<string>;
  /** The bot's server-wide permissions (human channel-scope names), for the rooms readiness row when no category is chosen. */
  serverPermissions?(guildId: string): Promise<string[]>;
  /** Creates or adopts the TCG Organizer and TCG Judge roles (IDs kept in `store`) and gives `organizerId` the Organizer role. Never throws for Discord failures. */
  ensureTournamentRoles(guildId: string, organizerId: string, store: TournamentRoleStore): Promise<TournamentRolesEnsureResultDto>;
}

export interface SetupServiceOptions {
  token: string | null;
  databaseConfigured: boolean;
  profile?: SetupProfileStore;
  /** Receives the match room choice at the end of setup. Its failure never fails setup. */
  roomSettings?: MatchRoomSetupSink;
  active(): Promise<SessionRow | null>;
  prepare(config: PrivateDiscordConfig): Promise<SessionRow>;
  onHandover(config: PrivateDiscordConfig, fresh: boolean): Promise<void>;
}

function selectionFromSession(session: SessionRow): SetupSelectionDto {
  return { guildId: session.guild_id, channelId: session.channel_id,
    matchChannels: session.identity_map.matchChannels ?? null,
    adminId: session.identity_map.adminId, publicMatchRooms: !!session.identity_map.publicMatchRooms };
}

function configFromSession(session: SessionRow, token: string): PrivateDiscordConfig {
  const common = { applicationId: session.application_id, guildId: session.guild_id,
    channelId: session.channel_id, adminId: session.identity_map.adminId, token,
    ...(session.identity_map.matchChannels ? { matchChannels: session.identity_map.matchChannels } : {}),
    ...(session.identity_map.publicMatchRooms ? { publicMatchRooms: true } : {}) };
  const identity = session.identity_map;
  return identity.kind === 'signup' ? { ...common, mode: 'signup' } :
    { ...common, mode: 'legacy', players: identity.players! };
}

function configFromSelection(selection: SetupSelectionDto, applicationId: string, token: string): PrivateDiscordConfig {
  const { matchChannels, matchRooms: _matchRooms, ...rest } = selection;
  return { ...rest, ...(matchChannels ? { matchChannels } : {}), applicationId, token, mode: 'signup' };
}

/** A selection without M1/M2 that is not a frozen text-only legacy event: the bot's room pool serves it. */
function pooled(selection: SetupSelectionDto, active: SessionRow | null): boolean {
  return selection.matchChannels === null && !(active && !active.identity_map.matchChannels && !active.identity_map.publicMatchRooms);
}

/** The pool is public rooms by nature: a new selection without M1/M2 is saved with public rooms on. */
function normalized(selection: SetupSelectionDto, active: SessionRow | null): SetupSelectionDto {
  return !active && selection.matchChannels === null && !selection.publicMatchRooms ?
    { ...selection, publicMatchRooms: true } : selection;
}

/** matchRooms is a pool placement, not identity: it never makes an active event look changed. */
function sameSelection(left: SetupSelectionDto, right: SetupSelectionDto): boolean {
  return left.guildId === right.guildId && left.channelId === right.channelId &&
    left.adminId === right.adminId && left.publicMatchRooms === right.publicMatchRooms &&
    left.matchChannels?.M1 === right.matchChannels?.M1 && left.matchChannels?.M2 === right.matchChannels?.M2;
}

function ownMessageError(error: unknown): boolean { return (error as { code?: number })?.code === 10008; }
const SNOWFLAKE = /^[1-9]\d{14,21}$/;
// Printable text only: no control characters, 1-100 characters after trimming (Discord's channel name limit).
const CONTROL = /[\u0000-\u001f\u007f]/;

function parseChannelCreate(body: unknown): SetupChannelCreateDto {
  const value = body as Partial<Record<keyof SetupChannelCreateDto, unknown>> | null;
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null;
  const name = typeof value?.name === 'string' ? value.name.trim() : '';
  if (!keys || keys.length !== 3 || !keys.every(key => ['guildId', 'name', 'type'].includes(key)) ||
      typeof value!.guildId !== 'string' || !SNOWFLAKE.test(value!.guildId) || (value!.type !== 'text' && value!.type !== 'voice'))
    throw new HttpError(400, 'bad_request', 'Choose a server, a channel name and text or voice.');
  if (!name || [...name].length > 100 || CONTROL.test(name))
    throw new HttpError(400, 'bad_request', 'Channel names must be 1-100 readable characters.');
  return { guildId: value!.guildId, name, type: value!.type };
}

/** The bootstrap has no match-command capability. Every check refreshes discovery and DB identity. */
export class SetupService {
  private discovery: SetupDiscovery | null = null;
  private discoveryIssue: string | null = null;
  private selectedConfig: PrivateDiscordConfig | null = null;
  private selectedFresh = false;
  private handedOver = false;
  private guideBusy = false;
  private openingDashboard = false;
  private finishing = false;
  private handoverError: string | null = null;

  constructor(private readonly options: SetupServiceOptions) {}

  attach(discovery: SetupDiscovery): void { this.discovery = discovery; this.discoveryIssue = null; }
  unavailable(message: string): void { this.discovery = null; this.discoveryIssue = message; }

  private async active(): Promise<SessionRow | null> {
    if (!this.options.databaseConfigured) throw new HttpError(503, 'unavailable',
      'Configure DATABASE_URL and run the database setup commands before starting a tournament.');
    try { return await this.options.active(); }
    catch { throw new HttpError(503, 'unavailable',
      'The rehearsal database is unavailable or its Discord schema is not ready. Check DATABASE_URL, db:setup and db:discord-setup.'); }
  }

  async status(): Promise<SetupStatusDto> {
    let profile: SetupProfile = { selection: null, guide: null, completed: false };
    let prerequisite: string | null = null;
    try { profile = await (this.options.profile ?? new SetupProfileStore()).read(); }
    catch { prerequisite = 'Setup profile is unreadable. Review data/discord-setup.json locally.'; }
    let active: SessionRow | null = null;
    try { active = await this.active(); }
    catch (error) { prerequisite ??= (error as Error).message; }
    const selection = active ? { ...selectionFromSession(active),
      ...(profile.selection?.matchRooms ? { matchRooms: profile.selection.matchRooms } : {}) } : profile.selection;
    if (!this.options.token) prerequisite ??= 'Set TCG_DISCORD_TOKEN or DISCORD_BOT_TOKEN in the local .env file.';
    if (this.discoveryIssue) prerequisite ??= this.discoveryIssue;
    if (!this.discovery && !prerequisite) prerequisite = 'Discord is connecting. Refresh this page shortly.';
    if (active && this.discovery && active.application_id !== this.discovery.applicationId)
      prerequisite = 'The authenticated bot application differs from the active saved event. Use the original bot token.';
    let check: SetupCheckDto | null = null;
    if (selection && !prerequisite) {
      try { check = await this.evaluate(selection, active, profile); }
      catch { prerequisite = 'Discord channel discovery is unavailable. Check bot access and refresh.'; }
    }
    return { prerequisite, activeEventId: active?.event_id ?? null, selection,
      frozen: !!active, botName: this.discovery?.botName ?? null, check,
      openingDashboard: this.openingDashboard, handoverError: this.handoverError };
  }

  async guilds(): Promise<SetupGuildDto[]> {
    if (!this.discovery) throw new HttpError(503, 'unavailable', this.discoveryIssue ?? 'Discord is not ready.');
    return this.discovery.guilds();
  }

  async channels(guildId: string): Promise<SetupChannelDto[]> {
    if (!this.discovery) throw new HttpError(503, 'unavailable', this.discoveryIssue ?? 'Discord is not ready.');
    const guilds = await this.discovery.guilds();
    if (!guilds.some(guild => guild.id === guildId)) throw new HttpError(400, 'bad_request', 'Select a server the bot belongs to.');
    return (await this.discovery.channels(guildId)).map(({ permissions: _permissions, afk: _afk, ...channel }) => channel);
  }

  /** Creates a channel in a server the bot belongs to, so the wizard can select it right away. */
  async createChannel(body: unknown): Promise<SetupChannelDto> {
    const input = parseChannelCreate(body);
    if (!this.discovery) throw new HttpError(503, 'unavailable', this.discoveryIssue ?? 'Discord is not ready.');
    if (!(await this.discovery.guilds()).some(guild => guild.id === input.guildId))
      throw new HttpError(400, 'bad_request', 'Select a server the bot belongs to.');
    let created: DiscoveredChannel;
    try { created = await this.discovery.createChannel(input.guildId, input.name, input.type); }
    catch (error) {
      if ((error as { code?: number })?.code === 50013) throw new HttpError(403, 'forbidden',
        'The bot needs the Manage Channels permission in this server to create channels. Grant it, or create the channel in Discord and press Refresh.');
      throw new HttpError(502, 'unavailable', 'Discord did not create the channel. Try again, or create it in Discord and press Refresh.');
    }
    const { permissions: _permissions, afk: _afk, ...channel } = created;
    return channel;
  }

  private async evaluate(selection: SetupSelectionDto, active: SessionRow | null,
    profile: SetupProfile): Promise<SetupCheckDto> {
    const discovery = this.discovery!;
    const issues: string[] = [];
    const frozen = !!active;
    if (active && !sameSelection(selection, selectionFromSession(active)))
      issues.push('An active event locks its server, channels, organizer and room mode. Resume that event without replacing it.');
    if (active && active.application_id !== discovery.applicationId)
      issues.push('The authenticated bot application differs from the active event.');
    const guild = (await discovery.guilds()).find(item => item.id === selection.guildId);
    if (!guild) issues.push('Select a server the bot belongs to.');
    const channels = guild ? await discovery.channels(guild.id) : [];
    const find = (id: string) => channels.find(channel => channel.id === id);
    const signup = find(selection.channelId);
    const pool = pooled(selection, active);
    const shared = !!active && !pool && selection.matchChannels === null;
    const legacyRooms = !shared && !pool;
    const m1 = legacyRooms ? find(selection.matchChannels?.M1 ?? '') : signup;
    const m2 = legacyRooms ? find(selection.matchChannels?.M2 ?? '') : signup;
    if (!signup || signup.type !== 'text') issues.push('Signup must use a discoverable server text channel.');
    // Existing rooms need no particular name: the bot renames adopted rooms to the room template.
    if (legacyRooms && (!m1 || m1.type !== 'voice')) issues.push('M1 must be a voice room.');
    if (legacyRooms && (!m2 || m2.type !== 'voice')) issues.push('M2 must be a voice room.');
    if (legacyRooms && (m1?.afk || m2?.afk)) issues.push('Match rooms cannot be the server AFK channel.');
    if (legacyRooms && (!selection.matchChannels || selection.matchChannels.M1 === selection.matchChannels.M2 ||
        selection.channelId === selection.matchChannels.M1 || selection.channelId === selection.matchChannels.M2))
      issues.push('Signup, M1 and M2 must be distinct channels.');
    const wanted = selection.matchRooms;
    const category = wanted?.categoryId ? find(wanted.categoryId) : undefined;
    if (wanted?.categoryId && (!category || category.type !== 'category'))
      issues.push('Choose a category the bot can see for the match rooms, or let the bot create one.');
    if (pool && !selection.publicMatchRooms) issues.push('The bot manages match rooms as public rooms; turn public match rooms on.');
    if (!guild || !/^[1-9]\d{14,21}$/.test(selection.adminId)) issues.push('Choose a valid organizer ID.');
    const required = (slot: 'signup' | 'M1' | 'M2') => slot === 'signup' || shared ? TEXT :
      selection.publicMatchRooms ? PUBLIC : VOICE;
    const capability = (slot: 'signup' | 'M1' | 'M2', channel: DiscoveredChannel | undefined, id: string): SetupCapabilityDto => ({
      slot, channelId: id, channelName: channel?.name ?? 'Channel not visible to bot',
      missing: channel ? required(slot).filter(permission => !channel.permissions.includes(permission)) : ['View Channel']
    });
    const capabilities = [capability('signup', signup, selection.channelId),
      ...(pool ? [] : [capability('M1', m1, selection.matchChannels?.M1 ?? selection.channelId),
        capability('M2', m2, selection.matchChannels?.M2 ?? selection.channelId)])];
    // Readiness for the bot-managed rooms: the chosen category, or the server itself for top-level rooms or a new category.
    if (pool || wanted) capabilities.push(await this.roomsCapability(discovery, guild?.id ?? null, category));
    const blocking = (row: SetupCapabilityDto) => row.slot === 'rooms' ? row.missing.filter(name => SETUP_ROOMS_BLOCKING.includes(name)) : row.missing;
    if (capabilities.some(row => blocking(row).length)) issues.push('Grant the bot the missing permissions shown for each channel.');
    if (active && !selection.publicMatchRooms) issues.push('This saved event uses private rooms; public-room mode cannot be changed during it.');
    const notice = profile.guide?.channelId === selection.channelId ?
      profile.guide.pending ? 'pending' : profile.guide.messageId ? 'posted' : 'none' : 'none';
    return { valid: issues.every(issue => issue.startsWith('This saved event uses private rooms')),
      frozen, botName: discovery.botName, capabilities, issues, guide: SETUP_GUIDE,
      notice, permissions: setupPermissionReport({ applicationId: discovery.applicationId, guildId: guild?.id ?? null,
        publicMatchRooms: selection.publicMatchRooms, capabilities, checkedAtMs: Date.now() }) };
  }

  private async roomsCapability(discovery: SetupDiscovery, guildId: string | null,
    category: DiscoveredChannel | undefined): Promise<SetupCapabilityDto> {
    if (category) return { slot: 'rooms', channelId: category.id, channelName: category.name,
      missing: ROOMS.filter(permission => !category.permissions.includes(permission)) };
    const held = guildId && discovery.serverPermissions ? await discovery.serverPermissions(guildId).catch(() => null) : null;
    return { slot: 'rooms', channelId: guildId ?? '', channelName: 'Server',
      missing: held ? ROOMS.filter(permission => !held.includes(permission)) : [] };
  }

  private parseSelection(body: unknown): SetupSelectionDto {
    if (!validSelection(body)) throw new HttpError(400, 'bad_request', 'Choose a server, organizer, signup text channel and where the match rooms go.');
    return body;
  }

  private async updateGuide(selection: SetupSelectionDto, result: SetupCheckDto,
    profile: SetupProfile): Promise<SetupCheckDto> {
    const signup = result.capabilities[0]!;
    if (signup.missing.includes('Send Messages') || signup.missing.includes('View Channel'))
      return { ...result, notice: 'cannot_post' };
    const store = this.options.profile ?? new SetupProfileStore();
    let guide = profile.guide?.channelId === selection.channelId ? profile.guide : null;
    if (guide?.pending || this.guideBusy) return { ...result, notice: 'pending' };
    this.guideBusy = true;
    try {
      const content = result.valid ? `Setup ready for ${this.discovery!.botName}.` :
        `Setup needs attention for ${this.discovery!.botName}: ${result.capabilities
          .filter(row => row.missing.length).map(row => `${row.channelName}: ${row.missing.join(', ')}`).join('; ')}. ${SETUP_GUIDE}`;
      if (!guide?.messageId) {
        guide = { channelId: selection.channelId, messageId: null, pending: true };
        await store.save({ selection, guide, completed: profile.completed }); // Durable ambiguity marker before POST.
      }
      let id: string;
      try { id = await this.discovery!.guide(selection.channelId, selection.adminId, content,
        guide.messageId, !result.valid && !guide.messageId); }
      catch (error) {
        if (!guide.messageId || !ownMessageError(error)) throw error;
        // Only a confirmed Unknown Message permits one replacement. Persist pending first.
        guide = { channelId: selection.channelId, messageId: null, pending: true };
        await store.save({ selection, guide, completed: profile.completed });
        id = await this.discovery!.guide(selection.channelId, selection.adminId, content, null, !result.valid);
      }
      await store.save({ selection, guide: { channelId: selection.channelId, messageId: id, pending: false },
        completed: profile.completed });
      return { ...result, notice: 'posted' };
    } catch { return { ...result, notice: 'pending' }; }
    finally { this.guideBusy = false; }
  }

  async check(body: unknown): Promise<SetupCheckDto> {
    const parsed = this.parseSelection(body);
    const current = await this.status();
    if (current.prerequisite) throw new HttpError(503, 'unavailable', current.prerequisite);
    const active = await this.active();
    const selection = normalized(parsed, active);
    const store = this.options.profile ?? new SetupProfileStore();
    const profile = await store.read();
    let result = await this.evaluate(selection, active, profile);
    if (active && !sameSelection(selection, selectionFromSession(active))) return result;
    result = await this.updateGuide(selection, result, profile);
    if (result.notice === 'cannot_post') await store.save({ selection, guide: profile.guide,
      completed: profile.completed });
    return result;
  }

  async finish(body: unknown): Promise<SetupFinishDto> {
    if (this.finishing || this.openingDashboard)
      throw new HttpError(409, 'conflict', 'Dashboard handover is already in progress.');
    this.finishing = true;
    try {
      const parsed = this.parseSelection(body);
      const state = await this.status();
      if (state.prerequisite) throw new HttpError(503, 'unavailable', state.prerequisite);
      const active = await this.active();
      const selection = normalized(parsed, active);
      const profile = await (this.options.profile ?? new SetupProfileStore()).read();
      const check = await this.evaluate(selection, active, profile);
      if (!check.valid) throw new HttpError(422, 'rule', check.issues.join(' '));
      const config = active ? configFromSession(active, this.options.token!) :
        configFromSelection(selection, this.discovery!.applicationId, this.options.token!);
      if (active && !sameIdentityMap(active.identity_map, config))
        throw new HttpError(409, 'conflict', 'Active event identity changed; refresh setup.');
      // Role trouble never fails setup: it is reported in the result and the dashboard offers Create TCG roles again.
      const roles = await this.ensureRoles(selection);
      let session = active;
      if (!session) {
        try { session = await this.options.prepare(config); }
        catch { throw new HttpError(409, 'conflict', 'Another process may have prepared or claimed the event. Refresh and review it.'); }
      }
      // Like roles, room settings trouble never fails setup: the Rooms tab shows and fixes it.
      const rooms = await this.applyRooms(selection, active, session.application_id);
      await (this.options.profile ?? new SetupProfileStore()).save({ selection, guide: profile.guide, completed: true });
      this.selectedConfig = config;
      this.selectedFresh = !active;
      this.openingDashboard = true;
      this.handoverError = null;
      return { openingDashboard: true, eventId: session.event_id, roles, rooms };
    } finally { this.finishing = false; }
  }

  private async applyRooms(selection: SetupSelectionDto, active: SessionRow | null,
    applicationId: string): Promise<{ problem: string | null }> {
    const input: SetupMatchRoomsDto | null = selection.matchRooms ??
      (pooled(selection, active) ? { categoryId: null, createCategory: false } : null);
    if (!input) return { problem: null };
    const requested = !!input.categoryId || input.createCategory;
    if (!this.options.roomSettings) return { problem: requested ?
      'The match room category could not be saved. Choose it later in the Rooms tab.' : null };
    try {
      await this.options.roomSettings.applySetup(selection.guildId, applicationId, input);
      return { problem: null };
    } catch {
      return { problem: 'The match room category could not be saved. Choose it later in the Rooms tab.' };
    }
  }

  private async ensureRoles(selection: SetupSelectionDto): Promise<TournamentRolesEnsureResultDto> {
    try {
      return await this.discovery!.ensureTournamentRoles(selection.guildId, selection.adminId,
        profileTournamentRoleStore(this.options.profile));
    } catch {
      return { organizer: 'failed', judge: 'failed', assigned: null,
        problem: 'The TCG roles could not be set up. Create them later in Admin tools > Settings > Tournament roles.' };
    }
  }

  async handover(): Promise<void> {
    if (this.handedOver || !this.selectedConfig) return;
    this.handedOver = true;
    await this.options.onHandover(this.selectedConfig, this.selectedFresh);
  }

  /** Restore the wizard after an unsuccessful live startup; the saved event is untouched. */
  async recover(message: string): Promise<void> {
    this.handedOver = false;
    this.openingDashboard = false;
    this.selectedConfig = null;
    this.handoverError = message;
    const store = this.options.profile ?? new SetupProfileStore();
    const profile = await store.read();
    await store.save({ ...profile, completed: false });
  }

  /** Resume a completed and healthy Discord configuration, including between events. */
  async readyConfig(): Promise<PrivateDiscordConfig | null> {
    const status = await this.status();
    if (status.prerequisite || !status.check?.valid) return null;
    const active = await this.active();
    const profile = await (this.options.profile ?? new SetupProfileStore()).read();
    if (!profile.completed || !profile.selection) return null;
    if (!active) return configFromSelection(profile.selection, this.discovery!.applicationId, this.options.token!);
    return sameSelection({ ...profile.selection, channelId: active.channel_id }, selectionFromSession(active))
      ? configFromSession(active, this.options.token!) : null;
  }
}

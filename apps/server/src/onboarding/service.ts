import type { SetupCapabilityDto, SetupChannelDto, SetupCheckDto, SetupFinishDto, SetupGuildDto,
  SetupSelectionDto, SetupStatusDto } from '@tcg-live/core';
import { HttpError } from '../admin/http/respond.js';
import { type PrivateDiscordConfig, sameIdentityMap } from '../discord/config.js';
import type { SessionRow } from '../discord/session.js';
import { SetupProfileStore, validSelection, type SetupProfile } from './profile.js';

export const SETUP_GUIDE = 'Edit each named match channel → Permissions → add/select the bot member itself → '
  + 'Manage Permissions: green Allow → Save Changes.';
const TEXT = ['View Channel', 'Send Messages', 'Read Message History', 'Embed Links', 'Attach Files'];
const VOICE = [...TEXT, 'Connect'];
const PUBLIC = [...VOICE, 'Manage Permissions', 'Manage Channels', 'Move Members'];

export interface DiscoveredChannel extends SetupChannelDto { permissions: string[]; afk: boolean }
export interface SetupDiscovery {
  readonly applicationId: string;
  readonly botName: string;
  guilds(): Promise<SetupGuildDto[]>;
  channels(guildId: string): Promise<DiscoveredChannel[]>;
  /** Creates once or edits an owned guide; `missing` is already validated. */
  guide(channelId: string, adminId: string, content: string, messageId: string | null,
    mentionAdmin: boolean): Promise<string>;
}

export interface SetupServiceOptions {
  token: string | null;
  databaseConfigured: boolean;
  profile?: SetupProfileStore;
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
  return { ...selection, matchChannels: selection.matchChannels!, applicationId, token, mode: 'signup' };
}

function sameSelection(left: SetupSelectionDto, right: SetupSelectionDto): boolean {
  return left.guildId === right.guildId && left.channelId === right.channelId &&
    left.adminId === right.adminId && left.publicMatchRooms === right.publicMatchRooms &&
    left.matchChannels?.M1 === right.matchChannels?.M1 && left.matchChannels?.M2 === right.matchChannels?.M2;
}

function ownMessageError(error: unknown): boolean { return (error as { code?: number })?.code === 10008; }

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
    const selection = active ? selectionFromSession(active) : profile.selection;
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
    const shared = !!active && !active.identity_map.matchChannels && selection.matchChannels === null;
    const m1 = shared ? signup : find(selection.matchChannels?.M1 ?? '');
    const m2 = shared ? signup : find(selection.matchChannels?.M2 ?? '');
    if (!signup || signup.type !== 'text') issues.push('Signup must use a discoverable server text channel.');
    const frozenPrivate = !!active && !selection.publicMatchRooms;
    if (!shared && (!m1 || m1.type !== 'voice' || (!frozenPrivate && !m1.name.startsWith('TCG Match '))))
      issues.push('M1 must be a dedicated TCG Match voice room.');
    if (!shared && (!m2 || m2.type !== 'voice' || (!frozenPrivate && !m2.name.startsWith('TCG Match '))))
      issues.push('M2 must be a dedicated TCG Match voice room.');
    if (!shared && (m1?.afk || m2?.afk)) issues.push('Match rooms cannot be the server AFK channel.');
    if (!shared && (!selection.matchChannels || selection.matchChannels.M1 === selection.matchChannels.M2 ||
        selection.channelId === selection.matchChannels.M1 || selection.channelId === selection.matchChannels.M2))
      issues.push('Signup, M1 and M2 must be distinct channels.');
    if (!guild || !/^[1-9]\d{14,21}$/.test(selection.adminId)) issues.push('Choose a valid organizer ID.');
    const required = (slot: 'signup' | 'M1' | 'M2') => slot === 'signup' || shared ? TEXT :
      selection.publicMatchRooms ? PUBLIC : VOICE;
    const capability = (slot: 'signup' | 'M1' | 'M2', channel: DiscoveredChannel | undefined, id: string): SetupCapabilityDto => ({
      slot, channelId: id, channelName: channel?.name ?? 'Channel not visible to bot',
      missing: channel ? required(slot).filter(permission => !channel.permissions.includes(permission)) : ['View Channel']
    });
    const capabilities = [capability('signup', signup, selection.channelId),
      capability('M1', m1, selection.matchChannels?.M1 ?? selection.channelId),
      capability('M2', m2, selection.matchChannels?.M2 ?? selection.channelId)];
    if (capabilities.some(row => row.missing.length)) issues.push('Grant the bot the missing permissions shown for each channel.');
    if (active && !selection.publicMatchRooms) issues.push('This saved event uses private rooms; public-room mode cannot be changed during it.');
    const notice = profile.guide?.channelId === selection.channelId ?
      profile.guide.pending ? 'pending' : profile.guide.messageId ? 'posted' : 'none' : 'none';
    return { valid: issues.every(issue => issue.startsWith('This saved event uses private rooms')),
      frozen, botName: discovery.botName, capabilities, issues, guide: SETUP_GUIDE,
      notice };
  }

  private parseSelection(body: unknown): SetupSelectionDto {
    if (!validSelection(body)) throw new HttpError(400, 'bad_request', 'Choose a server, organizer, signup text channel and two distinct match rooms.');
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
    const selection = this.parseSelection(body);
    const current = await this.status();
    if (current.prerequisite) throw new HttpError(503, 'unavailable', current.prerequisite);
    const active = await this.active();
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
      const selection = this.parseSelection(body);
      const state = await this.status();
      if (state.prerequisite) throw new HttpError(503, 'unavailable', state.prerequisite);
      const active = await this.active();
      const profile = await (this.options.profile ?? new SetupProfileStore()).read();
      const check = await this.evaluate(selection, active, profile);
      if (!check.valid) throw new HttpError(422, 'rule', check.issues.join(' '));
      const config = active ? configFromSession(active, this.options.token!) :
        configFromSelection(selection, this.discovery!.applicationId, this.options.token!);
      if (active && !sameIdentityMap(active.identity_map, config))
        throw new HttpError(409, 'conflict', 'Active event identity changed; refresh setup.');
      let session = active;
      if (!session) {
        try { session = await this.options.prepare(config); }
        catch { throw new HttpError(409, 'conflict', 'Another process may have prepared or claimed the event. Refresh and review it.'); }
      }
      await (this.options.profile ?? new SetupProfileStore()).save({ selection, guide: profile.guide, completed: true });
      this.selectedConfig = config;
      this.selectedFresh = !active;
      this.openingDashboard = true;
      this.handoverError = null;
      return { openingDashboard: true, eventId: session.event_id };
    } finally { this.finishing = false; }
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

  /** Only an already active, healthy frozen session may bypass the wizard. */
  async readyConfig(): Promise<PrivateDiscordConfig | null> {
    const status = await this.status();
    if (status.prerequisite || !status.activeEventId || !status.check?.valid) return null;
    const active = await this.active();
    const profile = await (this.options.profile ?? new SetupProfileStore()).read();
    return active && profile.completed && profile.selection &&
      sameSelection({ ...profile.selection, channelId: active.channel_id }, selectionFromSession(active))
      ? configFromSession(active, this.options.token!) : null;
  }
}

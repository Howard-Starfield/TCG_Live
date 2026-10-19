import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, type OverwriteType } from 'discord.js';
import { RuleError, type MatchId, type Player } from '../rehearsal/domain.js';
import { resolvePlayers, type SessionRow } from './session.js';
import type { EventState } from '../rehearsal/domain.js';
import type { PrivateDiscordConfig } from './config.js';

export type RoomOverwrite = { id: string; type: OverwriteType; allow: string; deny: string };
export type Room = MatchId;
const roomIds: Room[] = ['M1', 'M2'];
const flags = PermissionFlagsBits;
const everyoneAllow = flags.ViewChannel | flags.Connect | flags.ReadMessageHistory;
const everyoneDeny = flags.SendMessages | flags.AddReactions | flags.UseApplicationCommands;
const botAllow = everyoneAllow | flags.SendMessages | flags.EmbedLinks | flags.AttachFiles |
  flags.ManageRoles | flags.ManageChannels | flags.MoveMembers;
const organizerAllow = everyoneAllow | flags.SendMessages | flags.EmbedLinks;
const pairAllow = flags.SendMessages | flags.AddReactions | flags.UseApplicationCommands;

export function roomPlan(guildId: string, botId: string, organizerId: string,
  pair: string[]): RoomOverwrite[] {
  return [
    { id: guildId, type: 0, allow: everyoneAllow.toString(), deny: everyoneDeny.toString() },
    { id: botId, type: 1, allow: botAllow.toString(), deny: '0' },
    { id: organizerId, type: 1, allow: organizerAllow.toString(), deny: '0' },
    ...pair.filter(id => id !== botId && id !== organizerId).map(id =>
      ({ id, type: 1 as const, allow: pairAllow.toString(), deny: '0' }))
  ].sort((a, b) => a.id.localeCompare(b.id) || a.type - b.type);
}

export function sameOverwrites(left: readonly RoomOverwrite[], right: readonly RoomOverwrite[]): boolean {
  const normalize = (rows: readonly RoomOverwrite[]) => rows.map(row =>
    `${row.id}:${row.type}:${BigInt(row.allow)}:${BigInt(row.deny)}`).sort().join('|');
  return normalize(left) === normalize(right);
}

export async function backupRoomOverwrites(guildId: string, roomId: string,
  original: readonly RoomOverwrite[],
  directory = fileURLToPath(new URL('../../../../data/discord-room-overwrites/', import.meta.url))): Promise<void> {
  const path = join(directory, `${guildId}-${roomId}.json`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, `${JSON.stringify({ guildId, roomId, overwrites: original }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new RuleError('Public match room overwrite backup failed; no room policy was changed.');
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as { guildId?: string; roomId?: string; overwrites?: unknown };
      if (saved.guildId !== guildId || saved.roomId !== roomId || !Array.isArray(saved.overwrites)) throw new Error('invalid');
    } catch { throw new RuleError('Public match room overwrite backup is unreadable; no room policy was changed.'); }
  }
}

export interface RoomTransport {
  current(room: Room): Promise<RoomOverwrite[]>;
  assertPermissions(room: Room, operation: 'policy' | 'move'): Promise<void>;
  replace(room: Room, overwrites: RoomOverwrite[]): Promise<void>;
  voiceChannel(memberId: string): string | null;
  move(memberId: string, room: Room): Promise<void>;
  warnOrganizer(message: string): Promise<void>;
}

type Snapshot = { session: SessionRow; state: EventState };
export class MatchRoomReconciler {
  private accepting = true;
  private dirty = false;
  private force = false;
  private running?: Promise<void>;
  private failedPlans = new Map<Room, string>();
  private attempts = new Map<string, number[]>();
  private warned = new Set<string>();
  private moving = new Set<string>();
  private failedMoves = new Set<string>();
  private loggedMoves = new Set<string>();

  constructor(private readonly config: PrivateDiscordConfig, private readonly botId: string,
    private readonly afkId: string | null, private readonly transport: RoomTransport,
    private readonly read: () => Promise<Snapshot>, private readonly canAct: () => boolean,
    private readonly now: () => number = Date.now,
    private readonly backup = backupRoomOverwrites) {
    if (!config.publicMatchRooms || !config.matchChannels) throw new RuleError('Public match rooms are not configured.');
  }

  trigger(explicit = false, changedMemberId?: string): Promise<void> {
    if (!this.accepting || !this.canAct()) return Promise.resolve();
    if (explicit) this.failedMoves.clear();
    if (changedMemberId) this.failedMoves.delete(changedMemberId);
    this.dirty = true;
    this.force ||= explicit;
    if (!this.running) {
      this.running = this.drain().finally(() => { this.running = undefined; });
    }
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.accepting && this.canAct() && this.dirty) {
      this.dirty = false;
      const explicit = this.force;
      this.force = false;
      await this.pass(explicit);
    }
  }

  private requireActive(): void {
    if (!this.accepting || !this.canAct()) throw new RuleError('Public match room operation stopped.');
  }

  private async pass(explicit: boolean): Promise<void> {
    this.requireActive();
    const { session, state } = await this.read();
    const players = resolvePlayers(session, state);
    const assignedIds = players ? Object.values(players) : [];
    for (const id of this.attempts.keys()) if (!assignedIds.includes(id)) {
      this.attempts.delete(id);
      this.warned.delete(id);
      this.failedMoves.delete(id);
      this.loggedMoves.delete(id);
    }
    for (const room of roomIds) {
      this.requireActive();
      const pair = state.matches.find(match => match.id === room)!.players.map(player => players?.[player]).filter((id): id is string => !!id);
      const desired = roomPlan(this.config.guildId, this.botId, session.identity_map.adminId, pair);
      const current = await this.transport.current(room);
      const key = JSON.stringify({ desired, current });
      if (sameOverwrites(current, desired)) { this.failedPlans.delete(room); continue; }
      if (!explicit && this.failedPlans.get(room) === key) throw new RuleError(`Public match room ${room} policy is pending; use Refresh after permissions are fixed.`);
      try {
        this.requireActive();
        await this.transport.assertPermissions(room, 'policy');
        this.requireActive();
        await this.backup(this.config.guildId, this.config.matchChannels![room], current);
        const latest = await this.read();
        if (latest.session.event_id !== session.event_id || latest.state.version !== state.version) {
          this.dirty = true;
          return;
        }
        this.requireActive();
        await this.transport.replace(room, desired);
        this.failedPlans.delete(room);
      } catch (error) {
        this.failedPlans.set(room, key);
        if (error instanceof RuleError) throw error;
        throw new RuleError(`Public match room ${room} policy update failed.`);
      }
    }
    if (!state.published || !players) return;
    const active = new Map<string, Room>();
    for (const match of state.matches) if (match.phase !== 'final')
      for (const player of match.players) active.set(players[player], match.id);
    for (const id of assignedIds) {
      const room = active.get(id);
      if (!room || id === session.identity_map.adminId || id === this.botId ||
          this.moving.has(id) || this.failedMoves.has(id)) continue;
      const source = this.transport.voiceChannel(id);
      if (!source || source === this.afkId || source === this.config.matchChannels![room]) continue;
      const recent = (this.attempts.get(id) ?? []).filter(at => this.now() - at < 60_000);
      if (recent.length >= 3) {
        if (!this.warned.has(id)) {
          this.warned.add(id);
          this.requireActive();
          await this.transport.warnOrganizer(`Automatic placement paused for <@${id}> after three moves in one minute.`);
        }
        continue;
      }
      this.moving.add(id);
      try {
        // An aggregate change during a previous Discord call cannot authorize a stale move.
        const latest = await this.read();
        const resolved = resolvePlayers(latest.session, latest.state);
        if (latest.state.version !== state.version || latest.session.event_id !== session.event_id ||
            !latest.state.published || resolved?.[Object.keys(players).find(player => players[player as Player] === id) as Player] !== id) {
          this.dirty = true;
          return;
        }
        const currentMatch = latest.state.matches.find(match => match.id === room);
        if (!currentMatch || currentMatch.phase === 'final') { this.dirty = true; return; }
        const latestSource = this.transport.voiceChannel(id);
        if (!latestSource || latestSource === this.afkId || latestSource === this.config.matchChannels![room]) continue;
        this.requireActive();
        await this.transport.assertPermissions(room, 'move');
        this.requireActive();
        this.attempts.set(id, [...recent, this.now()]);
        await this.transport.move(id, room);
        this.loggedMoves.delete(id);
      } catch (error) {
        if (error instanceof RuleError && error.message === 'Public match room operation stopped.') throw error;
        // An ambiguous movement waits for this member's next voice event or explicit Refresh.
        if (!this.loggedMoves.has(id)) {
          process.stderr.write('Public match room move failed; waiting for another voice event.\n');
          this.loggedMoves.add(id);
        }
        this.failedMoves.add(id);
      } finally { this.moving.delete(id); }
    }
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.dirty = false;
    await this.running?.catch(() => {});
  }
}

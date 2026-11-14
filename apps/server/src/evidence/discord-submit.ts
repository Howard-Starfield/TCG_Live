// `/tcg-test evidence match:<M#> file:<attachment> link:<url> note:<text>`: the two seated players of a
// match (and the organizer) submit a clip or a link. Attachments are downloaded at once (Discord file
// links expire) through the same pipeline as dashboard uploads, with the player size cap.
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { MessageFlags, type Interaction } from 'discord.js';
import { EVIDENCE_PLAYER_MAX_BYTES, type MatchId } from '@tcg-live/core';
import type { DiscordFeature, DiscordFeatureContext } from '../discord/features.js';
import type { OpsActor } from '../ops/audit.js';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../ops/errors.js';
import { EvidenceFileError, EvidenceFiles, formatBytes, sharedEvidenceFiles } from './files.js';
import { parseEvidenceNote, parseEvidenceUrl } from './store.js';

export const EVIDENCE_SUBCOMMAND = 'evidence';
const MATCH = /^M[1-9]\d{0,3}$/;
/** Discord serves slash-command attachments from these hosts only; nothing else is fetched. */
const ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_PARALLEL_DOWNLOADS = 3;

export interface EvidenceAttachment { url: string; size: number; name: string; contentType: string | null }
export interface EvidenceCommandInput {
  guildId: string | null;
  userId: string;
  matchId: string | null;
  attachment: EvidenceAttachment | null;
  link: string | null;
  note: string | null;
}
export type EvidenceSubmitContext = Pick<DiscordFeatureContext, 'guildId' | 'adminId' | 'evidence' | 'matchRoom'>;
export interface EvidenceSubmitOptions {
  files?: EvidenceFiles;
  fetch?: typeof fetch;
  maxBytes?: number;
}

/** The reply text for one submission. Never throws. */
export class EvidenceSubmitter {
  private readonly files: EvidenceFiles;
  private readonly fetcher: typeof fetch;
  private readonly maxBytes: number;
  private downloads = 0;

  constructor(private readonly ctx: EvidenceSubmitContext, options: EvidenceSubmitOptions = {}) {
    this.files = options.files ?? sharedEvidenceFiles();
    this.fetcher = options.fetch ?? fetch;
    this.maxBytes = options.maxBytes ?? EVIDENCE_PLAYER_MAX_BYTES;
  }

  async submit(input: EvidenceCommandInput): Promise<string> {
    try {
      return await this.run(input);
    } catch (error) {
      if (error instanceof EvidenceFileError || error instanceof OpsInputError || error instanceof OpsNotFoundError ||
          error instanceof OpsConflictError) return error.message;
      return 'Evidence could not be saved. Try again, or send the organizer a link.';
    }
  }

  private async run(input: EvidenceCommandInput): Promise<string> {
    if (input.guildId !== this.ctx.guildId) return 'Evidence can be submitted only in the tournament server.';
    const matchId = (input.matchId ?? '').trim().toUpperCase();
    if (!MATCH.test(matchId)) return 'Give the match as shown on its card, for example M1.';
    if (!input.attachment && !input.link) return 'Attach a file or give an https:// link.';
    const note = parseEvidenceNote(input.note ?? undefined);
    const link = input.link ? parseEvidenceUrl(input.link.trim()) : null;
    const room = await this.ctx.matchRoom(matchId as MatchId);
    if (!room) return `${matchId} is not a match in the current round.`;
    const organizer = input.userId === this.ctx.adminId;
    if (!organizer && !room.playerIds.includes(input.userId))
      return 'Only the two players in this match or the organizer can submit evidence for it.';
    if (input.attachment) this.checkAttachment(input.attachment);
    const actor: OpsActor = { kind: organizer ? 'admin' : 'player', id: input.userId };
    const base = { eventId: room.eventId, matchId, source: 'discord' as const, submittedBy: input.userId, actor, note };
    const saved: string[] = [];
    if (link) {
      await this.ctx.evidence.createLink({ ...base, url: link });
      saved.push('link');
    }
    if (input.attachment) {
      const item = await this.download(input.attachment, base);
      saved.push(`file (${formatBytes(item.byteSize ?? 0)}${item.playable ? '' : ', download only'})`);
    }
    return `Evidence saved for ${matchId}: ${saved.join(' and ')}. The organizer can review it in the dashboard.`;
  }

  private checkAttachment(attachment: EvidenceAttachment): void {
    if (!Number.isSafeInteger(attachment.size) || attachment.size > this.maxBytes)
      throw new EvidenceFileError(413, `Files can be at most ${formatBytes(this.maxBytes)}. Upload longer clips somewhere and share a link.`);
    let url: URL;
    try { url = new URL(attachment.url); } catch { throw new EvidenceFileError(400, 'That attachment link is not valid.'); }
    if (url.protocol !== 'https:' || !ATTACHMENT_HOSTS.has(url.hostname))
      throw new EvidenceFileError(400, 'That attachment link is not valid.');
  }

  private async download(attachment: EvidenceAttachment, base: { eventId: string; matchId: string; source: 'discord';
    submittedBy: string; actor: OpsActor; note: string }) {
    if (this.downloads >= MAX_PARALLEL_DOWNLOADS) throw new EvidenceFileError(400, 'Other evidence is downloading. Try again in a minute.');
    this.downloads++;
    try {
      const response = await this.fetcher(attachment.url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok || !response.body) throw new EvidenceFileError(400, 'Discord did not provide the attachment. Try again.');
      const length = response.headers.get('content-length');
      const declared = length && /^\d{1,16}$/.test(length) ? Number(length) : attachment.size;
      const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
      try {
        return await this.files.ingest({ source, maxBytes: this.maxBytes, declaredBytes: declared, store: this.ctx.evidence,
          evidence: { ...base, originalName: attachment.name } });
      } finally { source.destroy(); }
    } finally { this.downloads--; }
  }
}

/** Reads the slash-command options; null for every other interaction. */
export function evidenceCommandInput(interaction: Interaction): EvidenceCommandInput | null {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'tcg-test' ||
      interaction.options.getSubcommand(false) !== EVIDENCE_SUBCOMMAND) return null;
  const file = interaction.options.getAttachment('file');
  return {
    guildId: interaction.guildId, userId: interaction.user.id,
    matchId: interaction.options.getString('match'),
    attachment: file ? { url: file.url, size: file.size, name: file.name, contentType: file.contentType } : null,
    link: interaction.options.getString('link'),
    note: interaction.options.getString('note')
  };
}

export function evidenceSubmitFeature(options: EvidenceSubmitOptions = {}): DiscordFeature {
  let detach: (() => void) | undefined;
  return {
    name: 'evidence-submit',
    start(ctx) {
      const submitter = new EvidenceSubmitter(ctx, options);
      const listener = (interaction: Interaction) => {
        if (!ctx.isActive()) return;
        const input = evidenceCommandInput(interaction);
        if (!input || !interaction.isChatInputCommand()) return;
        void (async () => {
          try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const content = await submitter.submit(input);
            await interaction.editReply({ content, allowedMentions: { parse: [] } });
          } catch { /* The interaction expired or Discord is unreachable. */ }
        })();
      };
      ctx.client.on('interactionCreate', listener);
      detach = () => { ctx.client.off('interactionCreate', listener); };
    },
    stop() { detach?.(); detach = undefined; }
  };
}

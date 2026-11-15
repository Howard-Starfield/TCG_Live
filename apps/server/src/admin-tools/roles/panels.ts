// Button-role panels: strict validation, hierarchy warnings and storage (tcg_button_role_panels).
// The table has no column for the required role or the "message deleted" mark, so both ride in the
// body jsonb next to { content, embed } (the column only requires an object).
import type pg from 'pg';
import { ADMIN_TOOLS_LIMITS as L, BUTTON_ROLE_MODES, type ButtonRoleButtonDto, type ButtonRoleMode, type MessageBodyDto } from '@tcg-live/core';
import { OpsConflictError, OpsNotFoundError } from '../../ops/errors.js';
import { withClient } from '../../rehearsal/store.js';
import { requireAdminToolsSchema } from '../schema.js';
import { buttonStyle, emojiOrNull, exactObject, fail, messageBody, oneOf, shapedObject, snowflake, snowflakeOrNull, text } from '../validate.js';
import { roleProblem, type PortRole } from './guild-port.js';
import type { ButtonRolePanelViewDto, RoleProblem, RoleWarningDto } from './types.js';

export interface StoredPanel {
  id: string; guildId: string; channelId: string; messageId: string | null;
  body: MessageBodyDto; mode: ButtonRoleMode; buttons: ButtonRoleButtonDto[];
  requiredRoleId: string | null;
  /** The posted message was found deleted; cleared on repost. */
  messageMissing: boolean;
  updatedAtMs: number;
}
export interface PanelInput {
  channelId: string; body: MessageBodyDto; mode: ButtonRoleMode; buttons: ButtonRoleButtonDto[]; requiredRoleId: string | null;
}

/** Strict parse of SaveButtonRolePanelExtDto. @everyone can never be a button or the required role. */
export function parsePanelInput(input: unknown, guildId: string): PanelInput {
  const value = shapedObject(input, ['channelId', 'body', 'mode', 'buttons'], ['requiredRoleId'], 'Panel');
  if (!Array.isArray(value.buttons) || value.buttons.length < 1 || value.buttons.length > L.buttonsPerPanel)
    fail(`A panel needs 1-${L.buttonsPerPanel} buttons.`);
  const buttons = (value.buttons as unknown[]).map((raw, index): ButtonRoleButtonDto => {
    const label = `Button ${index + 1}`;
    const item = exactObject(raw, ['roleId', 'label', 'emoji', 'style'], label);
    return { roleId: snowflake(item.roleId, `${label} role`), label: text(item.label, L.buttonLabelLength, `${label} label`),
      emoji: emojiOrNull(item.emoji, `${label} emoji`), style: buttonStyle(item.style, `${label} style`) };
  });
  if (new Set(buttons.map(button => button.roleId)).size !== buttons.length) fail('Each role can appear on only one button of a panel.');
  if (buttons.some(button => button.roleId === guildId)) fail('@everyone cannot be given by a button.');
  const requiredRoleId = value.requiredRoleId === undefined ? null : snowflakeOrNull(value.requiredRoleId, 'Required role');
  if (requiredRoleId === guildId) fail('Everyone already has @everyone; leave the required role empty instead.');
  return { channelId: snowflake(value.channelId, 'Channel'), body: messageBody(value.body, 'Panel message'),
    mode: oneOf(value.mode, BUTTON_ROLE_MODES, 'panel mode'), buttons, requiredRoleId };
}

const PROBLEM_TEXT: Record<RoleProblem, string> = {
  unknown: 'This role no longer exists.',
  managed: 'This role is managed by an integration; nobody can assign it.',
  'above-bot': "This role is at or above the bot's highest role. Move the bot's role above it in Server Settings > Roles.",
  everyone: '@everyone cannot be assigned.',
  elevated: 'This role has staff permissions (Administrator, Manage Server, Ban Members...); the bot never hands it out.'
};

/** Warnings for every role the bot cannot manage (buttons), and an unknown required role. */
export function panelWarnings(panel: Pick<PanelInput, 'buttons' | 'requiredRoleId'>, roles: readonly PortRole[], botTopPosition: number,
  guildId: string): RoleWarningDto[] {
  const byId = new Map(roles.map(role => [role.id, role]));
  const warnings: RoleWarningDto[] = [];
  for (const button of panel.buttons) {
    const problem = roleProblem(byId.get(button.roleId), guildId, botTopPosition) as RoleProblem | null;
    if (problem) warnings.push({ roleId: button.roleId, problem, message: `${button.label}: ${PROBLEM_TEXT[problem]}` });
  }
  if (panel.requiredRoleId && !byId.has(panel.requiredRoleId))
    warnings.push({ roleId: panel.requiredRoleId, problem: 'unknown', message: 'The required role no longer exists.' });
  return warnings;
}
export function roleWarning(roleId: string, roles: readonly PortRole[], botTopPosition: number, guildId: string): RoleWarningDto | null {
  const problem = roleProblem(roles.find(role => role.id === roleId), guildId, botTopPosition) as RoleProblem | null;
  return problem ? { roleId, problem, message: PROBLEM_TEXT[problem] } : null;
}

export function panelView(panel: StoredPanel, warnings: RoleWarningDto[]): ButtonRolePanelViewDto {
  return { id: panel.id, guildId: panel.guildId, channelId: panel.channelId, messageId: panel.messageId, body: panel.body,
    mode: panel.mode, buttons: panel.buttons, updatedAtMs: panel.updatedAtMs, requiredRoleId: panel.requiredRoleId,
    messageState: panel.messageMissing ? 'missing' : panel.messageId ? 'posted' : 'unpublished', warnings };
}

export interface ButtonRolePanelStore {
  list(guildId: string): Promise<StoredPanel[]>;
  get(guildId: string, id: string): Promise<StoredPanel | null>;
  /** Rejects with OpsConflictError past ADMIN_TOOLS_LIMITS.buttonRolePanels. */
  create(panel: StoredPanel): Promise<StoredPanel>;
  /** Rejects with OpsNotFoundError when gone. */
  update(panel: StoredPanel): Promise<StoredPanel>;
  delete(guildId: string, id: string): Promise<boolean>;
}

const tooMany = () => new OpsConflictError(`A server can have at most ${L.buttonRolePanels} button-role panels.`);
const gone = () => new OpsNotFoundError('That panel no longer exists.');

export class MemoryButtonRolePanelStore implements ButtonRolePanelStore {
  private readonly panels = new Map<string, StoredPanel>();
  async list(guildId: string) {
    return [...this.panels.values()].filter(panel => panel.guildId === guildId).sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map(panel => structuredClone(panel));
  }
  async get(guildId: string, id: string) {
    const panel = this.panels.get(id);
    return panel && panel.guildId === guildId ? structuredClone(panel) : null;
  }
  async create(panel: StoredPanel) {
    if ((await this.list(panel.guildId)).length >= L.buttonRolePanels) throw tooMany();
    this.panels.set(panel.id, structuredClone(panel));
    return structuredClone(panel);
  }
  async update(panel: StoredPanel) {
    if (!(await this.get(panel.guildId, panel.id))) throw gone();
    this.panels.set(panel.id, structuredClone(panel));
    return structuredClone(panel);
  }
  async delete(guildId: string, id: string) {
    if (!(await this.get(guildId, id))) return false;
    return this.panels.delete(id);
  }
}

interface PanelRow { id: string; guild_id: string; channel_id: string; message_id: string | null;
  body: MessageBodyDto & { requiredRoleId?: string | null; messageMissing?: boolean }; mode: ButtonRoleMode;
  buttons: ButtonRoleButtonDto[]; updated_at_ms: string }
const fromRow = (row: PanelRow): StoredPanel => ({ id: row.id, guildId: row.guild_id, channelId: row.channel_id, messageId: row.message_id,
  body: { content: row.body.content ?? null, embed: row.body.embed ?? null }, mode: row.mode, buttons: row.buttons,
  requiredRoleId: row.body.requiredRoleId ?? null, messageMissing: row.body.messageMissing === true, updatedAtMs: Number(row.updated_at_ms) });
const bodyJson = (panel: StoredPanel) => JSON.stringify({ ...panel.body, requiredRoleId: panel.requiredRoleId, messageMissing: panel.messageMissing });

export function pgButtonRolePanelStore(): ButtonRolePanelStore {
  const run = <T>(work: (client: pg.Client) => Promise<T>) => withClient(async client => { await requireAdminToolsSchema(client); return work(client); });
  const columns = 'id, guild_id, channel_id, message_id, body, mode, buttons, updated_at_ms';
  return {
    list: guildId => run(async client => (await client.query<PanelRow>(
      `SELECT ${columns} FROM public.tcg_button_role_panels WHERE guild_id = $1 ORDER BY updated_at_ms DESC`, [guildId])).rows.map(fromRow)),
    get: (guildId, id) => run(async client => {
      const row = (await client.query<PanelRow>(`SELECT ${columns} FROM public.tcg_button_role_panels WHERE guild_id = $1 AND id = $2`,
        [guildId, id])).rows[0];
      return row ? fromRow(row) : null;
    }),
    create: panel => run(async client => {
      // One statement: the count check and insert cannot race past the limit by more than concurrent requests.
      const result = await client.query(`INSERT INTO public.tcg_button_role_panels (${columns})
        SELECT $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8
        WHERE (SELECT count(*) FROM public.tcg_button_role_panels WHERE guild_id = $2) < $9`,
      [panel.id, panel.guildId, panel.channelId, panel.messageId, bodyJson(panel), panel.mode, JSON.stringify(panel.buttons),
        panel.updatedAtMs, L.buttonRolePanels]);
      if (result.rowCount !== 1) throw tooMany();
      return panel;
    }),
    update: panel => run(async client => {
      const result = await client.query(`UPDATE public.tcg_button_role_panels SET channel_id = $3, message_id = $4, body = $5::jsonb,
        mode = $6, buttons = $7::jsonb, updated_at_ms = $8 WHERE guild_id = $1 AND id = $2`,
      [panel.guildId, panel.id, panel.channelId, panel.messageId, bodyJson(panel), panel.mode, JSON.stringify(panel.buttons), panel.updatedAtMs]);
      if (result.rowCount !== 1) throw gone();
      return panel;
    }),
    delete: (guildId, id) => run(async client =>
      ((await client.query('DELETE FROM public.tcg_button_role_panels WHERE guild_id = $1 AND id = $2', [guildId, id])).rowCount ?? 0) === 1)
  };
}

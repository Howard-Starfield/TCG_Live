// Discord feature for button roles and bulk role jobs: answers 'br:' panel buttons with an ephemeral
// confirmation, and runs queued bulk jobs (resuming a job that was running when the bot stopped).
import { MessageFlags, type MessageComponentInteraction } from 'discord.js';
import type { DiscordFeature, DiscordFeatureContext } from '../../discord/features.js';
import { FEATURE_INTERACTION_PREFIXES } from '../../discord/interactions.js';
import { BulkRoleRunner, pgBulkRoleJobStore, type BulkRoleJobStore } from './bulk.js';
import { discordFailure, discordGuildPort, roleProblem, type RolesGuildPort } from './guild-port.js';
import { pgButtonRolePanelStore, type ButtonRolePanelStore } from './panels.js';
import { decideButtonRole, parsePanelCustomId } from './render.js';

export const BUTTON_ROLE_REASON = 'Button roles panel';
const RESUME_INTERVAL_MS = 60_000;

export interface RolesFeatureOptions {
  panels?: ButtonRolePanelStore;
  jobs?: BulkRoleJobStore;
  port?(ctx: DiscordFeatureContext): Promise<RolesGuildPort>;
  runner?: { pauseMs?: number; sleep?(ms: number): Promise<void> };
  resumeIntervalMs?: number;
}

type Reply = Pick<MessageComponentInteraction, 'customId' | 'user' | 'deferReply' | 'editReply' | 'reply'>;

/** Handles one panel click. Exported for tests (they pass a fake interaction and port). */
export async function handleButtonRoleClick(interaction: Reply, panels: ButtonRolePanelStore, port: RolesGuildPort): Promise<void> {
  const parsed = parsePanelCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({ content: 'This button is not available.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const answer = (content: string) => interaction.editReply({ content, allowedMentions: { parse: [] } });
  const panel = await panels.get(port.guildId, parsed.panelId);
  if (!panel) { await answer('This panel was removed by the staff.'); return; }
  const memberRoles = await port.memberRoles(interaction.user.id);
  if (!memberRoles) { await answer('You are not a member of this server.'); return; }
  const decision = decideButtonRole(panel, memberRoles, parsed.roleId);
  if (decision.kind === 'denied') { await answer(decision.message); return; }
  const { roles, botTopPosition } = await port.roles();
  const byId = new Map(roles.map(role => [role.id, role]));
  if ([...decision.add, ...decision.remove].some(roleId => roleProblem(byId.get(roleId), port.guildId, botTopPosition))) {
    await answer('The bot cannot change this role (it is managed, deleted, above the bot, or has staff permissions). Please tell the staff.');
    return;
  }
  try {
    for (const roleId of decision.add) await port.addRole(interaction.user.id, roleId, BUTTON_ROLE_REASON);
    for (const roleId of decision.remove) await port.removeRole(interaction.user.id, roleId, BUTTON_ROLE_REASON);
  } catch (error) { await answer(`That did not work: ${discordFailure(error)}`); return; }
  await answer(decision.message);
}

export function rolesFeature(options: RolesFeatureOptions = {}): DiscordFeature {
  const stops: Array<() => void> = [];
  let runner: BulkRoleRunner | null = null;
  return {
    name: 'roles',
    start(ctx) {
      const panels = options.panels ?? pgButtonRolePanelStore();
      const jobs = options.jobs ?? pgBulkRoleJobStore();
      const port = () => options.port ? options.port(ctx) : ctx.guild().then(discordGuildPort);
      stops.push(ctx.interactions.onComponent(FEATURE_INTERACTION_PREFIXES.buttonRoles, async interaction => {
        await handleButtonRoleClick(interaction, panels, await port());
      }));
      runner = new BulkRoleRunner({ store: jobs, guildId: ctx.guildId, port, isActive: () => ctx.isActive(), log: message => ctx.log(message),
        ...(options.runner?.pauseMs !== undefined ? { pauseMs: options.runner.pauseMs } : {}),
        ...(options.runner?.sleep ? { sleep: options.runner.sleep } : {}),
        audit: (kind, payload) => ctx.audit(kind, payload) });
      const current = runner;
      stops.push(() => current.stop());
      stops.push(ctx.on('adminToolsChanged', event => { if (event.area === 'roles') void current.kick(); }));
      // Resume after restart, and retry jobs that paused while Discord was unreachable.
      void current.kick();
      const timer = setInterval(() => { void current.kick(); }, options.resumeIntervalMs ?? RESUME_INTERVAL_MS);
      timer.unref();
      stops.push(() => clearInterval(timer));
    },
    stop() { for (const stop of stops.splice(0)) stop(); runner = null; }
  };
}

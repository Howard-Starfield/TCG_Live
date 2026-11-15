// `/tcg-admin` guild command: one subcommand per admin-tools feature. Feature agents append one entry to
// adminSubcommands and register the handler at runtime with ctx.interactions.onSubcommand(name, handler).
// Registration (registerPrivateCommand) upserts this command next to `/tcg-test`.
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type SlashCommandSubcommandBuilder } from 'discord.js';

export const ADMIN_COMMAND_NAME = 'tcg-admin';

export interface AdminSubcommand {
  /** 1-32 of [a-z0-9-]. */
  name: string;
  description: string;
  /** Adds options; leave out for none. */
  build?(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder;
}

/** Append-only list (Discord allows 25). Handlers live in the owning feature. */
export const adminSubcommands: AdminSubcommand[] = [
  { name: 'status', description: 'Admin tools status: privileged intents and restart notices' }
];

/** Staff-only by default (Manage Server); server admins can widen it in Server Settings > Integrations. */
export function adminCommandDefinition(subcommands: readonly AdminSubcommand[] = adminSubcommands) {
  if (subcommands.length > 25) throw new Error('Discord allows at most 25 subcommands.');
  const names = new Set<string>();
  const builder = new SlashCommandBuilder().setName(ADMIN_COMMAND_NAME).setDescription('TCG Live admin tools')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setContexts(InteractionContextType.Guild);
  for (const sub of subcommands) {
    if (!/^[a-z0-9-]{1,32}$/.test(sub.name) || names.has(sub.name)) throw new Error(`Invalid or duplicate subcommand ${sub.name}.`);
    names.add(sub.name);
    builder.addSubcommand(item => {
      const base = item.setName(sub.name).setDescription(sub.description);
      return sub.build ? sub.build(base) : base;
    });
  }
  return builder.toJSON();
}

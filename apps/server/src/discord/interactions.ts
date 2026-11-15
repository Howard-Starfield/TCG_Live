// Interaction routing seam for Discord features: buttons/selects and modals by custom-id prefix, and
// `/tcg-admin <subcommand>` by name. Features register handlers through DiscordFeatureContext.interactions,
// so adding one never edits controller.ts or runtime.ts. The controller keeps everything else ('p1:' card
// buttons, the 'judge:' modal, `/tcg-test`), and adapt() skips IDs that carry a feature prefix.
import type { ChatInputCommandInteraction, Interaction, MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { ADMIN_COMMAND_NAME, adminSubcommands } from './admin-command.js';

/**
 * Reserved custom-id prefixes, one per feature area. Feature agents append one line here. A prefix ends
 * with ':' and none may be a prefix of another or of the controller's own 'p1:' / 'judge:' IDs.
 * Keep custom IDs at most 100 characters (Discord's limit), prefix included.
 */
export const FEATURE_INTERACTION_PREFIXES = {
  adminTools: 'at:',
  tickets: 'tk:',
  buttonRoles: 'br:'
} as const;
export type FeatureInteractionPrefix = typeof FEATURE_INTERACTION_PREFIXES[keyof typeof FEATURE_INTERACTION_PREFIXES];

/** Custom-id prefixes the controller owns; never registrable. */
export const CONTROLLER_INTERACTION_PREFIXES = ['p1:', 'judge:'] as const;

const PREFIXES: readonly string[] = Object.values(FEATURE_INTERACTION_PREFIXES);

/** Throws when the registry is malformed (checked by tests and at router construction). */
export function assertPrefixRegistry(prefixes: readonly string[] = PREFIXES): void {
  const all = [...prefixes, ...CONTROLLER_INTERACTION_PREFIXES];
  for (const prefix of prefixes) {
    if (!/^[a-z][a-z0-9-]{0,7}:$/.test(prefix)) throw new Error(`Invalid interaction prefix ${prefix}.`);
  }
  for (const [index, prefix] of all.entries()) {
    for (const [other, candidate] of all.entries()) {
      if (index !== other && candidate.startsWith(prefix)) throw new Error(`Interaction prefix ${prefix} overlaps ${candidate}.`);
    }
  }
}

/** True when a custom ID belongs to a registered feature (the controller must ignore it). */
export function isFeatureInteractionId(customId: string): boolean {
  return PREFIXES.some(prefix => customId.startsWith(prefix));
}

export type ComponentHandler = (interaction: MessageComponentInteraction) => Promise<void>;
export type ModalHandler = (interaction: ModalSubmitInteraction) => Promise<void>;
export type SubcommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

/** What features see as `ctx.interactions`. Each register call returns an unregister function for stop(). */
export interface FeatureInteractions {
  onComponent(prefix: FeatureInteractionPrefix, handler: ComponentHandler): () => void;
  onModal(prefix: FeatureInteractionPrefix, handler: ModalHandler): () => void;
  /** `name` must be declared in adminSubcommands (discord/admin-command.ts). */
  onSubcommand(name: string, handler: SubcommandHandler): () => void;
}

export interface InteractionScope { applicationId: string; guildId: string }

type Routable = Pick<Interaction, 'applicationId' | 'guildId'> & {
  isMessageComponent(): boolean; isModalSubmit(): boolean; isChatInputCommand(): boolean;
};

/** One router per runtime; the runtime calls dispatch() from its interactionCreate listener. */
export class FeatureInteractionRouter implements FeatureInteractions {
  private readonly components = new Map<string, ComponentHandler>();
  private readonly modals = new Map<string, ModalHandler>();
  private readonly subcommands = new Map<string, SubcommandHandler>();

  constructor(private readonly scope: InteractionScope, private readonly log: (message: string) => void = () => {},
    private readonly declaredSubcommands: readonly string[] = adminSubcommands.map(sub => sub.name)) {
    assertPrefixRegistry();
  }

  onComponent(prefix: FeatureInteractionPrefix, handler: ComponentHandler) { return this.add(this.components, prefix, handler, 'component'); }
  onModal(prefix: FeatureInteractionPrefix, handler: ModalHandler) { return this.add(this.modals, prefix, handler, 'modal'); }
  onSubcommand(name: string, handler: SubcommandHandler) {
    if (!this.declaredSubcommands.includes(name)) throw new Error(`Subcommand ${name} is not declared in adminSubcommands.`);
    if (this.subcommands.has(name)) throw new Error(`Subcommand ${name} already has a handler.`);
    this.subcommands.set(name, handler);
    return () => { if (this.subcommands.get(name) === handler) this.subcommands.delete(name); };
  }

  private add<T>(map: Map<string, T>, prefix: string, handler: T, kind: string): () => void {
    if (!PREFIXES.includes(prefix)) throw new Error(`Interaction prefix ${prefix} is not reserved in FEATURE_INTERACTION_PREFIXES.`);
    if (map.has(prefix)) throw new Error(`Interaction prefix ${prefix} already has a ${kind} handler.`);
    map.set(prefix, handler);
    return () => { if (map.get(prefix) === handler) map.delete(prefix); };
  }

  /**
   * Routes a feature interaction to its handler. Returns true when the interaction belongs to a feature
   * (even when no handler is registered right now: the controller must not answer it either).
   */
  dispatch(interaction: Routable): boolean {
    if (interaction.applicationId !== this.scope.applicationId || interaction.guildId !== this.scope.guildId) return false;
    let run: (() => Promise<void>) | undefined;
    if (interaction.isMessageComponent()) {
      const component = interaction as unknown as MessageComponentInteraction;
      const prefix = PREFIXES.find(item => component.customId.startsWith(item));
      if (!prefix) return false;
      const handler = this.components.get(prefix);
      run = handler ? () => handler(component) : () => this.unavailable(component);
    } else if (interaction.isModalSubmit()) {
      const modal = interaction as unknown as ModalSubmitInteraction;
      const prefix = PREFIXES.find(item => modal.customId.startsWith(item));
      if (!prefix) return false;
      const handler = this.modals.get(prefix);
      run = handler ? () => handler(modal) : () => this.unavailable(modal);
    } else if (interaction.isChatInputCommand()) {
      const command = interaction as unknown as ChatInputCommandInteraction;
      if (command.commandName !== ADMIN_COMMAND_NAME) return false;
      const handler = this.subcommands.get(command.options.getSubcommand(false) ?? '');
      run = handler ? () => handler(command) : () => this.unavailable(command);
    } else return false;
    void run().catch(async () => {
      this.log('A Discord feature interaction failed; the member saw an error notice.');
      await this.unavailable(interaction as unknown as MessageComponentInteraction, 'That did not work. Try again in a moment.');
    });
    return true;
  }

  private async unavailable(interaction: MessageComponentInteraction | ModalSubmitInteraction | ChatInputCommandInteraction,
    content = 'This control is not available right now.'): Promise<void> {
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch { /* The interaction expired. */ }
  }
}

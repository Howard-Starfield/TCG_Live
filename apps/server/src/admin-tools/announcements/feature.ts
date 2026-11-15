// Discord feature for scheduled announcements: a catch-up pass on start (sent when < 1 h late, else
// marked missed), a periodic tick, and an immediate tick when the dashboard changes an announcement.
import type { DiscordFeature, DiscordFeatureContext } from '../../discord/features.js';
import { discordGuildPort, type RolesGuildPort } from '../roles/guild-port.js';
import { AnnouncementScheduler, pgAnnouncementStore, type AnnouncementStore } from './announcements.js';

export const ANNOUNCEMENT_TICK_MS = 15_000;

export interface AnnouncementsFeatureOptions {
  store?: AnnouncementStore;
  port?(ctx: DiscordFeatureContext): Promise<RolesGuildPort>;
  tickMs?: number;
  now?(): number;
}

export function announcementsFeature(options: AnnouncementsFeatureOptions = {}): DiscordFeature {
  const stops: Array<() => void> = [];
  return {
    name: 'announcements',
    async start(ctx) {
      const scheduler = new AnnouncementScheduler({ store: options.store ?? pgAnnouncementStore(), guildId: ctx.guildId,
        port: () => options.port ? options.port(ctx) : ctx.guild().then(discordGuildPort),
        ...(options.now ? { now: options.now } : {}),
        audit: (kind, payload) => ctx.audit(kind, payload) });
      // One log line per outage, not one per tick (the database may be down or migration 013 not applied yet).
      let failing = false;
      const run = (message: string) => scheduler.tick().then(() => { failing = false; }, () => {
        if (!failing) ctx.log(message);
        failing = true;
      });
      const tick = () => {
        if (!ctx.isActive()) return;
        void run('Announcements: the scheduled-send check failed; retrying quietly every few seconds.');
      };
      // Catch-up first, so announcements missed while the PC was off are handled before anything else.
      await run('Announcements: catch-up after start failed; retrying quietly every few seconds.');
      stops.push(ctx.on('adminToolsChanged', event => { if (event.area === 'announcements') tick(); }));
      const timer = setInterval(tick, options.tickMs ?? ANNOUNCEMENT_TICK_MS);
      timer.unref();
      stops.push(() => clearInterval(timer));
    },
    stop() { for (const stop of stops.splice(0)) stop(); }
  };
}

// Welcome / leave templates. Single pass over {user} (mention), {username}, {server}, {memberCount}, so a
// username or server name that itself contains a placeholder is never expanded again. Unknown placeholders
// stay as typed. Mention safety is enforced by allowedMentions, not by the text: only the joining user may
// be pinged, so "@everyone" in a username or template never pings anyone.
export interface TemplateValues { userId: string; username: string; server: string; memberCount: number | null }

const PLACEHOLDER = /\{(user|username|server|memberCount)\}/g;

export function renderLoggingTemplate(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    if (name === 'user') return `<@${values.userId}>`;
    if (name === 'username') return values.username;
    if (name === 'server') return values.server;
    return values.memberCount === null ? '?' : String(values.memberCount);
  }).slice(0, 2000);
}

/** allowedMentions for a welcome (ping only the joining user) or a leave message (ping nobody). */
export function templateMentions(kind: 'welcome' | 'leave', userId: string): { parse: []; users: string[] } {
  return { parse: [], users: kind === 'welcome' ? [userId] : [] };
}

const DISCORD_EPOCH = 1_420_070_400_000n;
/** Account creation time encoded in a Discord snowflake. */
export function snowflakeTimeMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

const DAY_MS = 86_400_000;
/** True when the account is younger than `days` days (0 never flags). */
export function isNewAccount(accountCreatedAtMs: number, days: number, nowMs: number): boolean {
  return days > 0 && nowMs - accountCreatedAtMs < days * DAY_MS;
}

// Live preview twin of the server's welcome renderer (apps/server/src/admin-tools/logging/template.ts):
// one pass over {user}, {username}, {server}, {memberCount}; unknown placeholders stay as typed.
export interface TemplateValues { user: string; username: string; server: string; memberCount: number | null }

export const TEMPLATE_PLACEHOLDERS = ['{user}', '{username}', '{server}', '{memberCount}'] as const;

export function renderTemplatePreview(template: string, values: TemplateValues): string {
  return template.replace(/\{(user|username|server|memberCount)\}/g, (_, name: string) =>
    name === 'user' ? values.user : name === 'username' ? values.username : name === 'server' ? values.server
      : values.memberCount === null ? '?' : String(values.memberCount)).slice(0, 2000);
}

// Client-side checks against the Discord AutoMod and contract limits, so the form explains a problem
// before the server refuses the save. The server validates again; these never replace it.
import { MODERATION_LIMITS as L, type CustomKeywordListDto, type ModerationSettingsBodyDto } from '@tcg-live/core';

export const SNOWFLAKE = /^[1-9]\d{14,21}$/;
export const LIST_ID = /^[a-z0-9-]{1,32}$/;

/** Field path (for example `text.customLists.0.words`) → message. Empty when the settings can be saved. */
export type SettingsErrors = Record<string, string>;

const length = (value: string) => [...value].length;

function checkTerms(errors: SettingsErrors, path: string, terms: readonly string[], max: number, label: string): void {
  if (terms.length > max) { errors[path] = `${label}: at most ${max} entries (Discord limit); this has ${terms.length}.`; return; }
  const long = terms.find(term => length(term) > L.wordLength);
  if (long !== undefined) { errors[path] = `${label}: "${long.slice(0, 20)}…" is longer than ${L.wordLength} characters.`; return; }
  if (terms.some(term => !term.trim())) errors[path] = `${label}: remove the empty entry.`;
}

function checkIds(errors: SettingsErrors, path: string, ids: readonly string[], max: number, label: string): void {
  if (ids.length > max) errors[path] = `${label}: at most ${max} (Discord limit).`;
  else if (ids.some(id => !SNOWFLAKE.test(id))) errors[path] = `${label}: each entry must be a Discord ID (15 to 22 digits).`;
}

/** Null when `pattern` is acceptable. JavaScript syntax is close to, not the same as, Discord's (Rust) regex. */
export function regexProblem(pattern: string): string | null {
  if (!pattern.trim()) return 'Empty pattern.';
  if (length(pattern) > L.regexLength) return `Longer than ${L.regexLength} characters.`;
  try { new RegExp(pattern, 'u'); } catch { return 'Not a valid regular expression.'; }
  return null;
}

function checkList(errors: SettingsErrors, list: CustomKeywordListDto, index: number, ids: Set<string>): void {
  const base = `text.customLists.${index}`;
  const name = list.name.trim();
  if (!name) errors[`${base}.name`] = 'Give the list a name.';
  else if (length(name) > L.listNameLength) errors[`${base}.name`] = `Names can be up to ${L.listNameLength} characters.`;
  if (!LIST_ID.test(list.id) || ids.has(list.id)) errors[`${base}.id`] = 'Internal list ID is invalid or repeated.';
  ids.add(list.id);
  checkTerms(errors, `${base}.words`, list.words, L.wordsPerList, 'Words');
  if (list.regexPatterns.length > L.regexPerList) errors[`${base}.regexPatterns`] = `Patterns: at most ${L.regexPerList} (Discord limit).`;
  else {
    const bad = list.regexPatterns.map(regexProblem).find(Boolean);
    if (bad) errors[`${base}.regexPatterns`] = `Patterns: ${bad}`;
  }
  checkTerms(errors, `${base}.allowList`, list.allowList, L.allowListPerCustomList, 'Allow list');
  if (list.enabled && list.words.length === 0 && list.regexPatterns.length === 0) {
    errors[`${base}.words`] ??= 'Add at least one word or pattern, or turn the list off.';
  }
  if (list.action === 'timeout' && (!Number.isInteger(list.timeoutSeconds)
    || list.timeoutSeconds < L.timeoutSecondsMin || list.timeoutSeconds > L.timeoutSecondsMax)) {
    errors[`${base}.timeoutSeconds`] = `Timeouts run from 1 minute to 28 days.`;
  }
}

export function validateSettings(settings: ModerationSettingsBodyDto): SettingsErrors {
  const errors: SettingsErrors = {};
  const { text, voice, retention } = settings;
  // The same AutoMod rules the server enforces on save (only for rules that would be active).
  if (text.enabled) {
    const flagOnly: string[] = [];
    if (text.preset.enabled) {
      if (!Object.values(text.preset.presets).some(Boolean)) errors['text.preset.presets'] = 'Select at least one preset list, or turn the preset filter off.';
      if ((text.preset.action as string) === 'timeout') errors['text.preset.action'] = 'Discord does not allow a timeout on the preset filter; choose Flag or Block.';
      if (text.preset.action === 'flag') flagOnly.push('the preset filter');
    }
    for (const list of text.customLists) if (list.enabled && list.action === 'flag') flagOnly.push(`"${list.name}"`);
    if (flagOnly.length > 0 && text.alertChannelId === null) {
      errors['text.alertChannelId'] = `"Flag only" (${flagOnly.join(', ')}) needs an alert channel: enter one, or switch the action to Block.`;
    }
  }
  checkTerms(errors, 'text.preset.allowList', text.preset.allowList, L.allowListPreset, 'Allow list');
  if (text.customLists.length > L.customLists) errors['text.customLists'] = `At most ${L.customLists} custom lists.`;
  const ids = new Set<string>();
  text.customLists.forEach((list, index) => checkList(errors, list, index, ids));
  if (text.alertChannelId !== null && !SNOWFLAKE.test(text.alertChannelId)) errors['text.alertChannelId'] = 'Enter a Discord channel ID (15 to 22 digits), or leave it empty.';
  if (length(text.blockMessage) > L.blockMessageLength) errors['text.blockMessage'] = `Up to ${L.blockMessageLength} characters (Discord limit).`;
  checkIds(errors, 'text.exemptChannelIds', text.exemptChannelIds, L.exemptChannels, 'Exempt channels');
  checkIds(errors, 'text.exemptRoleIds', text.exemptRoleIds, L.exemptRoles, 'Exempt roles');

  const range = (path: string, value: number, min: number, max: number, unit: string) => {
    if (!Number.isFinite(value) || value < min || value > max) errors[path] = `Choose ${min} to ${max} ${unit}.`;
  };
  range('voice.thresholdDbfs', voice.thresholdDbfs, L.thresholdDbfsMin, L.thresholdDbfsMax, 'dBFS');
  range('voice.sustainMs', voice.sustainMs, L.sustainMsMin, L.sustainMsMax, 'ms');
  range('voice.cooldownMs', voice.cooldownMs, L.cooldownMsMin, L.cooldownMsMax, 'ms');
  if (voice.notifyChannelId !== null && !SNOWFLAKE.test(voice.notifyChannelId)) errors['voice.notifyChannelId'] = 'Enter a Discord channel ID, or leave it empty.';

  if (retention.days !== null && (!Number.isInteger(retention.days) || retention.days < L.retentionDaysMin || retention.days > L.retentionDaysMax)) {
    errors['retention.days'] = `Choose a whole number of days from ${L.retentionDaysMin} to ${L.retentionDaysMax}.`;
  }
  if (settings.noticeText !== null && length(settings.noticeText) > L.noticeTextLength) errors.noticeText = `Up to ${L.noticeTextLength} characters.`;
  return errors;
}

/** Splits pasted text into terms: one per line or comma, trimmed, without empties or repeats. */
export function splitTerms(raw: string): string[] {
  return [...new Set(raw.split(/[\n,]/).map(term => term.trim()).filter(Boolean))];
}

/** A list ID derived from the name, unique among `taken`. */
export function listIdFor(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'list';
  let id = base;
  for (let suffix = 2; taken.includes(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

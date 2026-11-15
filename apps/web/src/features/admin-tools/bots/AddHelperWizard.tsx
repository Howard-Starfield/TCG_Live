// Guided helper setup: create the application, configure its Bot page, paste the token, invite, verify.
// The token leaves the form on submit whatever happens, and is never shown again.
import { MODERATION_LIMITS as L, type VoiceBotPoolDto, type VoiceBotStatusDto, type VoiceBotVerifyReportDto } from '@tcg-live/core';
import { Bot, ExternalLink, Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useAdminData } from '../../../data';
import { Button, Field, Input } from '../../../ui';
import { describeError } from '../../evidence/api';
import { addVoiceBot } from '../../moderation/api';
import { DEVELOPER_PORTAL_URL, verifyVoiceBot } from './api';
import { VerifyReport } from './VerifyReport';

export function AddHelperWizard({ helpers, channelIds, disabled, onPool }: {
  helpers: number; channelIds: string[]; disabled: boolean; onPool(pool: VoiceBotPoolDto): void;
}) {
  const { api } = useAdminData();
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<VoiceBotStatusDto | null>(null);
  const [report, setReport] = useState<VoiceBotVerifyReportDto | null>(null);
  const labelError = label.trim().length > L.voiceBotLabelLength ? `Up to ${L.voiceBotLabelLength} characters.` : null;
  const full = helpers >= L.voiceHelperBots;
  const canAdd = !disabled && !busy && !full && label.trim().length > 0 && token.length > 0 && !labelError;

  const add = async () => {
    if (!canAdd) return;
    const body = { label: label.trim(), token: token.trim() };
    setToken('');
    setBusy(true); setError(null); setReport(null);
    try {
      const pool = await addVoiceBot(api, body);
      onPool(pool);
      const helper = [...pool.bots].reverse().find(bot => bot.kind === 'helper' && bot.label === body.label) ?? null;
      setAdded(helper);
      setLabel('');
    } catch (cause) { setError(describeError(cause, 'The helper could not be added.')); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    if (!added) return;
    setBusy(true); setError(null);
    try { setReport(await verifyVoiceBot(api, added.id, channelIds.length ? channelIds : undefined)); }
    catch (cause) { setError(describeError(cause, 'The helper could not be verified.')); }
    finally { setBusy(false); }
  };

  return <section aria-label="Add helper bot" className="flex flex-col gap-3 rounded-lg bg-raised p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
    <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg"><Bot aria-hidden className="size-3.5" />Add a helper bot
      <span className="font-normal text-fg-subtle">({helpers} / {L.voiceHelperBots})</span></h3>
    <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-xs text-fg-muted">
      <li>Open the <a className="inline-flex items-center gap-0.5 text-accent underline" href={DEVELOPER_PORTAL_URL} target="_blank" rel="noreferrer">
        Discord Developer Portal<ExternalLink aria-hidden className="size-3" /></a> and create a <b>New Application</b> (for example “TCG Recorder 2”).</li>
      <li>On its <b>Bot</b> page: turn off <b>Public Bot</b>, turn off <b>Requires OAuth2 Code Grant</b>, leave the privileged intents off, then <b>Reset Token</b> and copy it.</li>
      <li>Paste a label and the token here. The server checks the token with Discord and refuses the main bot's own token.</li>
      <li>Open the invite link it gives you: the helper only gets <b>View Channel</b> and <b>Connect</b>. It never speaks; the main bot posts the monitoring notice.</li>
      <li>Press <b>Verify</b> to check it can join every match room.</li>
    </ol>
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void add(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label" error={labelError}>
          <Input value={label} disabled={disabled || busy || full} onChange={event => setLabel(event.target.value)} placeholder="Helper 1" />
        </Field>
        <Field label="Bot token" description="Type or paste it yourself. It is stored only on this PC and never shown again.">
          <Input type="password" value={token} autoComplete="off" spellCheck={false} disabled={disabled || busy || full}
            onChange={event => setToken(event.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="primary" icon={<Plus aria-hidden />} loading={busy && !added} disabled={!canAdd}>Add helper</Button>
      </div>
    </form>
    {full && <p className="text-xs text-fg-muted">The limit of {L.voiceHelperBots} helpers is reached.</p>}
    {added && <div className="flex flex-col gap-2 rounded-md bg-sunken p-2 text-xs">
      <p className="text-fg">“{added.label}” added.</p>
      {added.inviteUrl ? <a className="text-accent underline" href={added.inviteUrl} target="_blank" rel="noreferrer">Invite it to the server (View Channel and Connect)</a>
        : <p className="text-fg-muted">Discord could not be reached to read its application ID; press Verify once online to get the invite link.</p>}
      <div><Button size="sm" variant="ghost" icon={<ShieldCheck aria-hidden />} loading={busy} onClick={() => { void verify(); }}>Verify</Button></div>
      {report && <VerifyReport report={report} />}
    </div>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}

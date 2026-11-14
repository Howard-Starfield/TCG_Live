import { BookmarkPlus, FolderOpen, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { EventSummaryDto, TournamentDirectoryDto, TournamentDirectoryEntryDto } from '@tcg-live/core';
import { adminKeys, useAdminData } from '../../data';
import { ConfirmDialog, useToast, type MenuEntry } from '../../ui';
import { useShell } from '../shell/model';
import { CreateTournamentDialog } from './CreateTournamentDialog';
import { tournamentDirectoryKey } from './directory';

export function useTournamentMenu() {
  const shell = useShell();
  const { api, queryClient } = useAdminData();
  const toast = useToast();
  const [deleting, setDeleting] = useState<TournamentDirectoryEntryDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<TournamentDirectoryEntryDto | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);

  async function saveTemplate(entry: TournamentDirectoryEntryDto) {
    if (savingTemplate) return;
    setSavingTemplate(true);
    try {
      await api.createTournamentDraft({
        draftId: crypto.randomUUID(), isTemplate: true, name: entry.name,
        game: entry.game ?? shell.directory?.defaultGame ?? 'one-piece',
        description: entry.description, matchMinutes: entry.matchMinutes, signupCapacity: entry.signupCapacity,
        bannerStyle: entry.bannerStyle, signupChannelId: entry.signupChannelId, swissRules: entry.swissRules
      });
      await queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey });
      toast.show({ title: 'Template saved', description: 'Find it under Drafts → Templates.', tone: 'success' });
    } catch (cause) {
      toast.show({ title: 'Could not save template', description: cause instanceof Error ? cause.message : undefined, tone: 'danger' });
    } finally {
      setSavingTemplate(false);
    }
  }

  function items(entry: TournamentDirectoryEntryDto, open: () => void): MenuEntry[] {
    const actions: MenuEntry[] = entry.isTemplate ? [] : [{ id: 'open', label: 'Open tournament', icon: <FolderOpen />, onSelect: open }];
    if (shell.session.commandsEnabled && entry.isTemplate) {
      actions.push({ id: 'use-template', label: 'Use template…', icon: <FolderOpen />, onSelect: () => setSource(entry) });
    } else if (shell.session.commandsEnabled && (entry.status === 'retired' || entry.completed)) {
      actions.push({ id: 'restart', label: 'Restart tournament…', icon: <RotateCcw />, onSelect: () => setSource(entry) });
      actions.push({ id: 'save-template', label: 'Save as template', icon: <BookmarkPlus />, disabled: savingTemplate,
        onSelect: () => { void saveTemplate(entry); } });
    }
    if (entry.status !== 'retired' && shell.session.commandsEnabled) {
      actions.push({ id: 'delete', label: entry.status === 'active' ? 'Delete active tournament…' : entry.isTemplate ? 'Delete template…' : 'Delete draft…', danger: true, icon: <Trash2 />, onSelect: () => setDeleting(entry) });
    }
    return actions;
  }

  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      const active = deleting.status === 'active';
      const id = encodeURIComponent(deleting.eventId);
      const result = await api.request<{ cleanupPending?: boolean }>('DELETE', active ? `/tournaments/${id}` : `/tournaments/drafts/${id}`);
      await queryClient.cancelQueries({ queryKey: tournamentDirectoryKey });
      queryClient.setQueriesData<TournamentDirectoryDto>({ queryKey: tournamentDirectoryKey }, directory => directory && ({
        ...directory, entries: directory.entries.filter(entry => entry.eventId !== deleting.eventId)
      }));
      if (active) {
        await queryClient.cancelQueries({ queryKey: adminKeys.events() });
        queryClient.setQueryData<EventSummaryDto[]>(adminKeys.events(), events => events?.filter(event => event.eventId !== deleting.eventId));
      }
      if (shell.draft?.eventId === deleting.eventId) shell.showDrafts();
      if (active && shell.viewed.eventId === deleting.eventId) shell.showHome();
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey }),
        ...(active ? [queryClient.invalidateQueries({ queryKey: adminKeys.events() })] : [])
      ]);
      setDeleting(null);
      toast.show({ title: active ? 'Active tournament deleted' : deleting.isTemplate ? 'Template deleted' : 'Tournament draft deleted', tone: result.cleanupPending ? undefined : 'success',
        description: result.cleanupPending ? 'Discord cleanup is pending. Check the old signup and match channels.' : undefined });
    } catch (cause) {
      toast.show({ title: 'Could not delete tournament', description: cause instanceof Error ? cause.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return { items, startFrom: setSource, saveTemplate, savingTemplate, confirmation: <>
    {source && <CreateTournamentDialog open initial={source} defaultGame={shell.directory?.defaultGame ?? 'one-piece'}
      onClose={() => setSource(null)} onSaved={entry => { setSource(null); shell.selectDraft(entry); }} />}
    <ConfirmDialog open={!!deleting} pending={busy} danger
    title={`Delete ${deleting?.name ?? 'tournament'}?`}
    confirmLabel={deleting?.status === 'active' ? 'Delete active tournament' : deleting?.isTemplate ? 'Delete template' : 'Delete draft'}
    description={deleting?.status === 'active'
      ? 'This ends signup and all matches immediately. Discord controls are disabled and audit records are retained.'
      : deleting?.isTemplate ? 'This permanently deletes the template.' : 'This permanently deletes the draft and its saved settings.'}
    onCancel={() => setDeleting(null)} onConfirm={() => { void remove(); }} /></> };
}

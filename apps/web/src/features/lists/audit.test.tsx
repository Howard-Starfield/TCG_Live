import { auditTimeline, final, liveDispute } from '@tcg-live/core/fixtures';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { syntheticAudit } from './fixtureData';
import { EMPTY_AUDIT_FILTERS, filterAudit } from './model';
import { bodyRows, renderList } from './testUtils';

const TABLE = /^Audit log/;
const sequences = () => bodyRows(TABLE).map(row => Number(within(row).getAllByRole('cell')[1]!.textContent));

async function renderAudit(options: Parameters<typeof renderList>[2] = { audit: auditTimeline, liveTail: auditTimeline.length }) {
  const view = renderList(liveDispute, 'audit', options);
  await screen.findByRole('table', { name: TABLE });
  await waitFor(() => expect(bodyRows(TABLE).length).toBeGreaterThan(0));
  return view;
}

describe('Audit tab', () => {
  it('lists applied entries newest first with the requested columns', async () => {
    await renderAudit();
    await waitFor(() => expect(sequences()).toHaveLength(17));
    expect(sequences()[0]).toBe(17);
    expect(screen.getByRole('columnheader', { name: /#/ })).toHaveAttribute('aria-sort', 'descending');
    for (const name of ['Time', 'Actor', 'Via', 'Command', 'Match', 'Result']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(name) })).toBeInTheDocument();
    }
    const newest = within(bodyRows(TABLE)[0]!);
    expect(newest.getByText('Dee Ross')).toBeInTheDocument();
    expect(newest.getByText('discord')).toBeInTheDocument();
    expect(newest.getAllByText('dispute')).toHaveLength(2);   // command and result
    expect(newest.getByText('rev 1')).toBeInTheDocument();
    expect(newest.getByText('M2')).toBeInTheDocument();
    expect(screen.getByText(/Only applied changes are stored/)).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('17 loaded')).toBeInTheDocument();
  });

  it('sorts ascending from the # header', async () => {
    const user = userEvent.setup();
    await renderAudit();
    await user.click(within(screen.getByRole('columnheader', { name: /#/ })).getByRole('button'));
    expect(sequences()[0]).toBe(1);
  });

  it('filters by actor kind, source, match and command type', async () => {
    const user = userEvent.setup();
    await renderAudit();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Actor kind' }), 'admin');
    expect(sequences()).toEqual([10, 5]);
    expect(screen.getByText('2 of 17')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Via' }), 'web');
    expect(sequences()).toEqual([10]);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Match' }), 'M1');
    expect(sequences()).toEqual([12, 11]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Match' }), 'none');
    expect(sequences()).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Match' }), 'all');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Command type' }), 'ready');
    expect(sequences()).toEqual([14, 13, 12, 11]);
  });

  it('searches names, commands and results, with an empty state', async () => {
    const user = userEvent.setup();
    await renderAudit();
    await user.type(screen.getByRole('searchbox', { name: 'Search audit' }), 'dee dispute');
    expect(sequences()).toEqual([17]);
    await user.clear(screen.getByRole('searchbox', { name: 'Search audit' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search audit' }), 'nothing like this');
    expect(screen.getByText('No entries match')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(sequences()).toHaveLength(17);
    expect(screen.getByRole('searchbox', { name: 'Search audit' })).toHaveValue('');
  });

  it('expands a row to its raw JSON and collapses it again', async () => {
    const user = userEvent.setup();
    await renderAudit();
    const row = bodyRows(TABLE)[0]!;
    row.focus();
    await user.keyboard('{Enter}');
    expect(row).toHaveAttribute('aria-current', 'true');
    const detail = screen.getByRole('region', { name: /#17.*disputed the result of M2/ });
    expect(within(detail).getByRole('button', { name: /Raw JSON/ })).toHaveAttribute('aria-expanded', 'true');
    const code = detail.querySelector('code')!;
    expect(JSON.parse(code.textContent!)).toEqual(auditTimeline[16]);
    await user.click(bodyRows(TABLE)[0]!);
    expect(screen.queryByRole('region', { name: /#17/ })).not.toBeInTheDocument();
    await user.click(bodyRows(TABLE)[1]!);
    await user.click(screen.getByRole('button', { name: 'Close entry 16' }));
    expect(screen.queryByRole('region', { name: /#16/ })).not.toBeInTheDocument();
  });

  it('loads older entries for a streamed event', async () => {
    const user = userEvent.setup();
    const audit = syntheticAudit(auditTimeline, 700);
    const { fixture } = await renderAudit({ audit, liveTail: 40 });
    const button = await screen.findByRole('button', { name: 'Load older' });
    expect(screen.getByText('40 loaded')).toBeInTheDocument();
    await user.click(button);
    expect(fixture.calls).toContain(`GET /events/${liveDispute.eventId}/audit?after=160&limit=500`);
    await waitFor(() => expect(screen.getByText('540 loaded')).toBeInTheDocument());
  });

  it('loads newer pages for an event read over HTTP', async () => {
    const user = userEvent.setup();
    const audit = syntheticAudit(auditTimeline, 520);
    const { fixture } = await renderAudit({ audit });
    const button = await screen.findByRole('button', { name: 'Load newer' });
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    await user.click(button);
    expect(fixture.calls).toContain(`GET /events/${liveDispute.eventId}/audit?after=500&limit=500`);
    await waitFor(() => expect(screen.getByText('520 loaded')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Load newer' })).not.toBeInTheDocument();
  });

  it('shows loading, error and empty states', async () => {
    const pending = renderList(liveDispute, 'audit', { auditMode: 'pending' });
    expect(await screen.findByText('Loading audit…')).toBeInTheDocument();
    pending.unmount();
    const failing = renderList(liveDispute, 'audit', { auditMode: 'error' });
    expect(await screen.findByText('Could not load the audit')).toBeInTheDocument();
    failing.unmount();
    renderList(liveDispute, 'audit', { audit: [], liveTail: 0 });
    expect(await screen.findByText('No applied changes yet')).toBeInTheDocument();
  });
});

describe('filterAudit', () => {
  it('matches timer and CLI entries and member names in commands', () => {
    const entries = syntheticAudit(auditTimeline, 120);
    expect(filterAudit(entries, { ...EMPTY_AUDIT_FILTERS, actor: 'system' }, final).every(entry => entry.via === 'system')).toBe(true);
    expect(filterAudit(entries, { ...EMPTY_AUDIT_FILTERS, via: 'cli' }, final).map(entry => entry.sequence)).toEqual([50, 100]);
    const removal = { ...auditTimeline[0]!, sequence: 999, actor: { kind: 'admin' as const },
      command: { type: 'signupRemove', memberId: auditTimeline[0]!.principalId!, reason: 'no show' } };
    expect(filterAudit([removal], { ...EMPTY_AUDIT_FILTERS, query: 'ava no show' }, final)).toHaveLength(1);
  });
});

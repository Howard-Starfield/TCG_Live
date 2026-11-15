import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CAPABILITIES, type LocalSettingsDto } from '@tcg-live/core';
import { describe, expect, it } from 'vitest';
import { renderConsole, sessionFixture } from '../../app/testing';
import { json } from '../../data/test/fakes';

const ready = () => screen.findByRole('complementary', { name: 'Sidebar' });
const banner = (id: string) => document.querySelector(`[data-banner="${id}"]`);
const settings = (on: boolean, voice: Partial<LocalSettingsDto['voiceMonitoring']> = {}): LocalSettingsDto => ({
  dashboardActions: { enabled: on, saved: on, forcedByEnv: false },
  voiceMonitoring: { saved: false, running: false, forcedByEnv: false, restartRequired: false, ...voice } });
const readOnly = { ...sessionFixture, mode: 'discord' as const, commandsEnabled: false, capabilities: ['dashboard.read' as const] };

describe('dashboard actions switch', () => {
  it('off: a banner explains what is hidden, and Turn on applies at once by re-reading the session', async () => {
    const user = userEvent.setup();
    let on = false;
    const { server } = renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, on ? { ...sessionFixture, mode: 'discord', localSettings: true }
        : { ...readOnly, localSettings: true }));
      server.always('GET /settings/local', () => json(200, settings(on)));
      server.always('PUT /settings/local', () => { on = true; return json(200, settings(true)); });
    } });
    await ready();
    await waitFor(() => expect(banner('dashboard-actions')).toHaveTextContent('Dashboard actions are off.'));
    expect(banner('dashboard-actions')).toHaveTextContent(/judging and corrections.*hidden/);
    await user.click(within(banner('dashboard-actions') as HTMLElement).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(banner('dashboard-actions')).toBeNull());
    expect(server.callsTo('PUT /settings/local')[0]?.body).toEqual({ dashboardActions: true });
    expect(server.callsTo('GET /session').length).toBeGreaterThan(1);
  });

  it('off on a direct run: the banner names the .env flag and offers no switch', async () => {
    const { server } = renderConsole({ setup: server => { server.always('GET /session', () => json(200, readOnly)); } });
    await ready();
    await waitFor(() => expect(banner('dashboard-actions')).toHaveTextContent('TCG_ADMIN_COMMANDS=1'));
    expect(within(banner('dashboard-actions') as HTMLElement).queryByRole('button')).toBeNull();
    expect(server.callsTo('GET /settings/local')).toHaveLength(0);
  });

  it('on, or in the demo: no banner', async () => {
    renderConsole();
    await ready();
    expect(banner('dashboard-actions')).toBeNull();
  });

  it('a saved voice change that needs a restart shows a restart notice', async () => {
    renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', localSettings: true }));
      server.always('GET /settings/local', () => json(200, settings(true, { saved: true, running: false, restartRequired: true })));
    } });
    await ready();
    await waitFor(() => expect(banner('voice-restart')).toHaveTextContent('Restart to apply voice monitoring.'));
    expect(banner('voice-restart')).toHaveTextContent('npm start');
  });

  it('the sidebar lists Moderation & evidence and Dashboard options', async () => {
    const user = userEvent.setup();
    renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...CAPABILITIES], mode: 'discord',
        moderation: true, localSettings: true }));
      server.always('GET /settings/local', () => json(200, settings(true)));
    } });
    await ready();
    const nav = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(await within(nav).findByText('Moderation & evidence')).toBeInTheDocument();
    await user.click(within(nav).getByText('Dashboard options'));
    const dialog = await screen.findByRole('dialog', { name: 'Dashboard options' });
    await waitFor(() => expect(within(dialog).getByRole('switch', { name: 'Allow dashboard actions' }))
      .toHaveAttribute('aria-checked', 'true'));
  });
});

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json } from '../data/test/fakes';
import { renderConsole } from './testing';

const errorBody = (code: string, message: string) => ({ error: { code, message } });

describe('login gate', () => {
  it('signed out: explains the console link and validates the pasted value', async () => {
    const user = userEvent.setup();
    renderConsole({ signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Sign in to TCG Live' })).toBeInTheDocument();
    expect(screen.getByText(/in the terminal where the bot/)).toBeInTheDocument();
    expect(screen.getByText(/Each new tab signs in through the link again/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText(/Paste the full console link/)).toBeInTheDocument();
  });

  it('shows an actionable error when the server rejects the link', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ signedIn: false });
    server.once('POST /session', () => json(401, errorBody('unauthenticated', 'Invalid launch token.')));
    await user.type(await screen.findByLabelText('Console link'), 'http://127.0.0.1:3000/#login=stale-token');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = (await screen.findByText('Sign-in failed')).closest<HTMLElement>('[role="alert"]')!;
    expect(alert).toHaveTextContent('Sign-in failed');
    expect(alert).toHaveTextContent(/may come from an earlier run, or it was rotated/);
    expect(server.callsTo('POST /session')[0]?.body).toEqual({ token: 'stale-token' });
  });

  it('signs in from the pasted link and opens the console', async () => {
    const user = userEvent.setup();
    renderConsole({ signedIn: false });
    await user.type(await screen.findByLabelText('Console link'), 'http://127.0.0.1:3000/#login=good-token');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: /Needs you/ })).toBeInTheDocument();
  });

  it('shows a splash while a stored session is validated', async () => {
    renderConsole({ setup: server => server.once('GET /session', () => new Promise<Response>(() => {})) });
    expect(await screen.findByTestId('login-splash')).toHaveTextContent('Signing in…');
  });

  it('error state: a transient failure offers Try again', async () => {
    const user = userEvent.setup();
    renderConsole({ setup: server => server.once('GET /session', () => json(503, errorBody('unavailable', 'Shutting down.'))) });
    const alert = (await screen.findByText('Sign-in failed')).closest<HTMLElement>('[role="alert"]')!;
    expect(alert).toHaveTextContent(/not ready yet/);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: /Needs you/ })).toBeInTheDocument();
  });

  it('expired session: explains why the console signed out', async () => {
    renderConsole({ setup: server => server.once('GET /session', () => json(401, errorBody('unauthenticated', 'Session expired.'))) });
    expect(await screen.findByText(/Your session ended/)).toBeInTheDocument();
  });

  it('signs in when the console link is opened again in the same tab (fragment change only)', async () => {
    const { server } = renderConsole({ signedIn: false });
    await screen.findByRole('heading', { name: 'Sign in to TCG Live' });
    await act(async () => {
      window.history.replaceState(null, '', '/#login=fragment-token');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByRole('heading', { name: /Needs you/ })).toBeInTheDocument();
    expect(server.callsTo('POST /session')[0]?.body).toEqual({ token: 'fragment-token' });
    expect(window.location.hash).toBe('');
  });

  it('sign out returns to the login screen', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole();
    await screen.findByRole('heading', { name: /Needs you/ });
    await user.click(screen.getByRole('button', { name: /Theme and account/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByText(/You signed out/)).toBeInTheDocument();
    await waitFor(() => expect(server.callsTo('DELETE /session')).toHaveLength(1));
  });
});

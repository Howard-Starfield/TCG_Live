import { CircleAlert, KeyRound, LoaderCircle, LogIn, Terminal } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { launchTokenFromInput, useSession, type ApiError, type SignedOutReason } from '../../data';
import { Button, Field, Input } from '../../ui';
import { BrandMark } from './BrandMark';

const NOTICE: Record<SignedOutReason, string | null> = {
  'no-session': null,
  'logged-out': 'You signed out. Open the console link again to continue.',
  expired: 'Your session ended: it expired, or the bot restarted. Open the current console link to sign in again.'
};

/** Explains a failed sign-in in terms the admin can act on. */
export function signInErrorText(error: ApiError): string {
  switch (error.code) {
    case 'unauthenticated':
      return 'That link was not accepted. It may come from an earlier run, or it was rotated. Copy the latest link from the terminal.';
    case 'too_many_requests':
      return 'Too many sign-in attempts. Wait a moment, then try again.';
    case 'network':
      return 'The console server could not be reached. Check that the bot (or the demo) is still running.';
    case 'bad_request':
      return error.message || 'Paste the console link printed in the terminal.';
    case 'unavailable':
      return 'The console is shutting down or not ready yet. Try again in a moment.';
    default:
      return error.message || 'Sign-in failed. Try again.';
  }
}

/** Login gate: signed-out, signing-in and error states. */
export function LoginScreen() {
  const session = useSession();
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const { state } = session;
  const pending = state.status === 'signing-in';
  const { login } = session;

  // Opening the console link in this tab again only changes the fragment (no reload): sign in from it.
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      if (!/[#&]login=/.test(hash)) return;
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
      const token = launchTokenFromInput(hash);
      if (!token) return;
      setSubmitted(false);
      void login(token);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [login]);

  // Fragment logins and stored-token checks sign in without the form: show a quiet splash.
  if (pending && !submitted) {
    return (
      <div className="shell-login" data-testid="login-splash">
        <div role="status" className="flex flex-col items-center gap-3 text-fg-muted">
          <BrandMark size="lg" />
          <span className="inline-flex items-center gap-2 text-[13px]">
            <LoaderCircle aria-hidden className="size-4 animate-spin" /> Signing in…
          </span>
        </div>
      </div>
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!launchTokenFromInput(value)) {
      setFieldError('Paste the full console link (it contains #login=) or the token after it.');
      return;
    }
    setFieldError(null);
    setSubmitted(true);
    void session.login(value);
  };

  const notice = state.status === 'signed-out' ? NOTICE[state.reason] : null;
  const error = state.status === 'error' ? state.error : null;

  return (
    <div className="shell-login">
      <main aria-labelledby="login-title" className="shell-login-card">
        <div className="flex items-center gap-2.5">
          <BrandMark size="lg" />
          <div>
            <h1 id="login-title" className="text-[17px] font-semibold leading-tight text-fg">Sign in to TCG Live</h1>
            <p className="text-xs text-fg-subtle">Local admin console</p>
          </div>
        </div>

        {notice && <p role="status" className="shell-login-note">{notice}</p>}

        <ol className="mt-5 flex flex-col gap-3 text-[13px] text-fg-muted">
          <li className="flex gap-3">
            <span aria-hidden className="shell-login-step"><Terminal /></span>
            <span>
              Find the line <b className="font-semibold text-fg">Admin console:</b> in the terminal where the bot
              (or <code className="shell-code">npm run admin:demo</code>) is running.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="shell-login-step"><KeyRound /></span>
            <span>
              Open that link (it ends in <code className="shell-code">#login=…</code>) in this tab, or paste it below.
            </span>
          </li>
        </ol>

        {error && (
          <div role="alert" className="shell-login-error">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Sign-in failed</p>
              <p className="mt-0.5 text-fg-muted">{signInErrorText(error)}</p>
            </div>
            {error.isTransient && (
              <Button size="sm" variant="ghost" onClick={() => { setSubmitted(true); void session.retry(); }}>Try again</Button>
            )}
          </div>
        )}

        <form className="mt-5 flex flex-col gap-3" onSubmit={onSubmit} noValidate>
          <Field label="Console link" error={fieldError ?? undefined}
            description="The link works for this browser tab only. Each new tab signs in through the link again.">
            <Input value={value} onChange={event => { setValue(event.target.value); setFieldError(null); }}
              placeholder="http://127.0.0.1:3000/#login=…" autoComplete="off" spellCheck={false}
              autoFocus disabled={pending} className="font-mono text-xs" />
          </Field>
          <Button type="submit" variant="primary" icon={<LogIn aria-hidden />} loading={pending} className="self-start">
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-5 border-t border-line pt-3 text-2xs text-fg-subtle">
          Sessions stay in this tab and end after 2 hours idle or 12 hours in total. The console only listens on
          this computer.
        </p>
      </main>
    </div>
  );
}

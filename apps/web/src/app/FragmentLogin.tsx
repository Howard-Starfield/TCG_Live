// Opening the console link in a tab that is already loaded only changes the fragment (no reload), so
// the data layer's one-time bootstrap never sees it. Consume it here, in every session state, and
// strip it from the address bar and history straight away.
import { useEffect, useRef } from 'react';
import { consumeLoginFragment, useSession } from '../data';
import { useToast } from '../ui';

export function FragmentLogin() {
  const session = useSession();
  const toast = useToast();
  const latest = useRef({ session, toast });
  latest.current = { session, toast };

  useEffect(() => {
    const onHashChange = () => {
      const token = consumeLoginFragment(window.location, window.history);
      if (!token) return;
      const { session: current, toast: notify } = latest.current;
      if (current.status === 'signed-in') {
        // A signed-in tab keeps its session; the link is not needed (and is never kept in the URL).
        notify.show({ title: 'Already signed in', description: 'This tab already has a session, so the console link was not used.' });
        return;
      }
      void current.login(token);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return null;
}

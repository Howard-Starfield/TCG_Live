import { useSession } from '../data';
import { LoginScreen } from '../features/shell/LoginScreen';
import { Shell } from '../features/shell/Shell';

/** Signed in: the console. Anything else: the login screen (which also covers signing-in and errors). */
export function SessionGate() {
  const session = useSession();
  if (session.status === 'signed-in' && session.session) return <Shell session={session.session} />;
  return <LoginScreen />;
}

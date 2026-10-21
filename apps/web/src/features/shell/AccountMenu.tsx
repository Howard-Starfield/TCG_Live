import { Laptop, Link2, LogOut, Moon, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useSession } from '../../data';
import { ConfirmDialog, Menu, useToast, type MenuEntry, type Placement, type TriggerProps } from '../../ui';
import { useConsolePreferences } from '../../app/preferences';

export interface AccountMenuProps {
  trigger: (props: TriggerProps) => ReactNode;
  placement?: Placement;
}

/** Theme choice, rotate console link, sign out. */
export function AccountMenu({ trigger, placement = 'bottom-end' }: AccountMenuProps) {
  const session = useSession();
  const toast = useToast();
  const [preferences, update] = useConsolePreferences();
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);

  const rotate = async () => {
    setRotating(true);
    try {
      await session.rotateLink();
      setConfirming(false);
      toast.show({
        title: 'New console link printed in the terminal',
        description: 'The previous link no longer works. This tab stays signed in; open the new link to sign in other tabs.',
        tone: 'success', duration: 9000
      });
    } catch (error) {
      setConfirming(false);
      toast.show({ title: 'Could not rotate the link', description: error instanceof Error ? error.message : undefined, tone: 'danger' });
    } finally {
      setRotating(false);
    }
  };

  const items: MenuEntry[] = [
    { type: 'label', id: 'theme-label', label: 'Theme' },
    { id: 'theme-light', label: 'Light', checked: preferences.theme === 'light', onSelect: () => update({ theme: 'light' }) },
    { id: 'theme-dark', label: 'Dark', checked: preferences.theme === 'dark', onSelect: () => update({ theme: 'dark' }) },
    { id: 'theme-system', label: 'System', checked: preferences.theme === 'system', onSelect: () => update({ theme: 'system' }) },
    { type: 'separator', id: 'sep-1' },
    { id: 'rotate', label: 'Rotate console link…', textValue: 'Rotate console link', icon: <Link2 />, onSelect: () => setConfirming(true) },
    { type: 'separator', id: 'sep-2' },
    { id: 'sign-out', label: 'Sign out', icon: <LogOut />, onSelect: () => { void session.logout(); } }
  ];

  return (
    <>
      <Menu label="Account and theme" items={items} trigger={trigger} placement={placement} />
      <ConfirmDialog open={confirming} onCancel={() => setConfirming(false)} onConfirm={() => { void rotate(); }}
        pending={rotating} confirmLabel="Rotate link" title="Rotate the console link?"
        description="The bot prints a fresh console link in its terminal and the current link stops working. Tabs that are already signed in stay signed in." />
    </>
  );
}

/** Icon for the current theme preference, for menu triggers. */
export function ThemeIcon({ theme }: { theme: 'light' | 'dark' | 'system' }) {
  if (theme === 'light') return <Sun aria-hidden />;
  if (theme === 'dark') return <Moon aria-hidden />;
  return <Laptop aria-hidden />;
}

// "?" opens the keyboard shortcuts overlay anywhere in the console (never while typing). The overlay
// lists SHORTCUTS and links to the full Capabilities & shortcuts page.
import { Keyboard } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Badge, Button, Dialog, Kbd } from '../../ui';
import { useHelpShortcut } from '../shell/useShortcuts';
import { SHORTCUTS, type ShortcutEntry } from './capabilities';

export function ShortcutKeys({ entry }: { entry: ShortcutEntry }) {
  return <span className="inline-flex flex-wrap items-center gap-1">
    {entry.keys.map((combo, index) => <Fragment key={combo.join('+')}>
      {index > 0 && <span className="text-2xs text-fg-subtle">or</span>}
      <Kbd keys={combo} />
    </Fragment>)}
  </span>;
}

export function ShortcutList({ entries = SHORTCUTS }: { entries?: readonly ShortcutEntry[] }) {
  return <table className="w-full text-xs" aria-label="Keyboard shortcuts">
    <thead className="sr-only"><tr><th>Keys</th><th>Action</th><th>Where</th></tr></thead>
    <tbody className="divide-y divide-line">
      {entries.map(entry => <tr key={`${entry.what}:${entry.where}`}>
        <td className="whitespace-nowrap py-1.5 pr-3 align-top"><ShortcutKeys entry={entry} /></td>
        <td className="py-1.5 pr-3 align-top text-fg">{entry.what}{entry.wave && <Badge tone="accent" className="ml-1.5" title="Added in this release">New</Badge>}</td>
        <td className="py-1.5 align-top text-fg-subtle">{entry.where}</td>
      </tr>)}
    </tbody>
  </table>;
}

/** Mounted once by the shell. `onOpenPage` shows the full page (omitted outside the shell). */
export function ShortcutsOverlay({ onOpenPage }: { onOpenPage?: () => void }) {
  const [open, setOpen] = useState(false);
  useHelpShortcut(() => setOpen(current => !current));
  return <Dialog open={open} onClose={() => setOpen(false)} width="lg"
    title={<span className="inline-flex items-center gap-2"><Keyboard aria-hidden className="size-4" />Keyboard shortcuts</span>}
    description="Press ? anywhere (except while typing) to show this list."
    footer={<>
      {onOpenPage && <Button variant="ghost" onClick={() => { setOpen(false); onOpenPage(); }}>All capabilities & shortcuts</Button>}
      <Button onClick={() => setOpen(false)}>Close</Button>
    </>}>
    <ShortcutList />
  </Dialog>;
}

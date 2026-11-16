import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../../ui';
import { EditorDialog } from './EditorDialog';
import { useHighlightNew } from './useHighlightNew';

MotionGlobalConfig.skipAnimations = true;

function Host({ dirty = false, busy = false, preview, onClose }: { dirty?: boolean; busy?: boolean; preview?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button onClick={() => setOpen(true)}>Open editor</Button>
    <EditorDialog open={open} title="New thing" dirty={dirty} busy={busy} onClose={() => { onClose?.(); setOpen(false); }}
      preview={preview ? <p>Live preview</p> : undefined} footer={<Button>Save</Button>}>
      <label>Name<input /></label>
    </EditorDialog>
  </>;
}

describe('EditorDialog', () => {
  it('closes at once when nothing was edited and returns focus to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open editor' }));
    await screen.findByRole('dialog', { name: 'New thing' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Open editor' })).toHaveFocus();
  });

  it('asks before discarding unsaved changes on Escape and the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host dirty onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open editor' }));
    const dialog = await screen.findByRole('dialog', { name: 'New thing' });
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveFocus();

    await user.keyboard('{Escape}');
    await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    expect(onClose).not.toHaveBeenCalled();
    // Escape inside the confirm closes only the confirm.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('dialog', { name: 'New thing' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    let confirm = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    confirm = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot be dismissed while busy', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host dirty busy onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open editor' }));
    const dialog = await screen.findByRole('dialog', { name: 'New thing' });
    await user.keyboard('{Escape}');
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeDisabled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New thing' })).toBeInTheDocument();
  });

  it('shows the preview beside the form under its own heading', async () => {
    const user = userEvent.setup();
    render(<Host preview />);
    await user.click(screen.getByRole('button', { name: 'Open editor' }));
    const dialog = await screen.findByRole('dialog', { name: 'New thing' });
    expect(within(dialog).getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    expect(within(dialog).getByText('Live preview')).toBeInTheDocument();
  });
});

describe('useHighlightNew', () => {
  function List() {
    const highlight = useHighlightNew();
    const [ids, setIds] = useState(['a']);
    return <>
      <button onClick={() => { setIds(['a', 'b']); highlight.highlight('b'); }}>Add b</button>
      <ul>{ids.map(id => <li key={id} ref={highlight.ref(id)} className={highlight.isHighlighted(id) ? 'ring-2' : ''}>{id}</li>)}</ul>
    </>;
  }

  it('scrolls a just-added item into view and clears the highlight after about two seconds', async () => {
    const user = userEvent.setup();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<List />);
    await user.click(screen.getByRole('button', { name: 'Add b' }));
    const item = await screen.findByText('b');
    expect(item).toHaveClass('ring-2');
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
    await waitFor(() => expect(item).not.toHaveClass('ring-2'), { timeout: 3500 });
  });
});

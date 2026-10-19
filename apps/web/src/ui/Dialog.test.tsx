import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, Dialog } from './Dialog';
import { Menu } from './Menu';
import { PortalScope } from './Portal';
import { Tooltip } from './Tooltip';
import { skipMotion } from './testing';

beforeAll(skipMotion);

function DialogHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <button type="button">Elsewhere</button>
      <Dialog open={open} onClose={() => { setOpen(false); onClose?.(); }} title="Rotate link" description="Old link stops working."
        footer={<><button type="button" onClick={() => setOpen(false)}>Cancel</button><button type="button">Rotate</button></>}>
        <input aria-label="Note" />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('is a labelled modal that focuses its first field and makes the page inert', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Rotate link' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Old link stops working.');
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Elsewhere', hidden: true }).closest('[inert]')).not.toBeNull();
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Rotate' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Rotate' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
  });

  it('closes on Escape, lifts inert and restores focus to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(document.querySelector('[inert]')).toBeNull();
  });
});

function ConfirmHarness({ onConfirm, requireReason = true }: { onConfirm: (reason: string) => void; requireReason?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog open={open} danger requireReason={requireReason} title="Correct M2" confirmLabel="Correct result"
      onCancel={() => setOpen(false)} onConfirm={reason => { onConfirm(reason); setOpen(false); }} />
  );
}

describe('ConfirmDialog', () => {
  it('requires a non-empty reason before confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Correct M2' });
    expect(dialog).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Correct result' });
    expect(confirm).toBeDisabled();
    const reason = screen.getByRole('textbox', { name: /reason/i });
    expect(reason).toHaveFocus();
    expect(reason).toBeRequired();
    await user.type(reason, '   ');
    expect(confirm).toBeDisabled();
    await user.tab();
    expect(reason).toHaveAccessibleDescription('A reason is required.');
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    await user.type(reason, ' Judge ruled for Brock ');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Judge ruled for Brock');
  });

  it('confirms without a reason when none is required', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} requireReason={false} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Correct result' }));
    expect(onConfirm).toHaveBeenCalledWith('');
  });
});

describe('Dialog in a PortalScope', () => {
  function Scoped() {
    const [open, setOpen] = useState(true);
    return (
      <PortalScope>
        <button type="button">Background</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Already open">
          <input aria-label="Inside" />
        </Dialog>
      </PortalScope>
    );
  }

  it('moves focus in, makes the page inert and restores focus when mounted already open', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.textContent = 'Opener';
    document.body.append(opener);
    opener.focus();
    render(<Scoped />);
    const dialog = await screen.findByRole('dialog', { name: 'Already open' });
    expect(dialog.closest('[data-portal-scope]')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Inside' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Background', hidden: true }).closest('[inert]')).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(document.querySelector('[inert]')).toBeNull();
    opener.remove();
  });

  it('opens a defaultOpen Menu inside the scope and closes it with Escape', async () => {
    const user = userEvent.setup();
    render(
      <PortalScope>
        <Menu label="Scoped" defaultOpen items={[{ id: 'a', label: 'Alpha', onSelect: vi.fn() }]}
          trigger={props => <button type="button" {...props}>Scoped</button>} />
      </PortalScope>
    );
    const menu = await screen.findByRole('menu', { name: 'Scoped' });
    expect(menu.closest('[data-portal-scope]')).not.toBeNull();
    expect(menu.style.top).not.toBe('-9999px');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});

describe('Escape layering', () => {
  function Layered({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onClose={() => { setOpen(false); onClose(); }} title="Layered">
        <Tooltip content="Explains the action" delay={0}><button type="button">Hinted</button></Tooltip>
        <Menu label="Actions" items={[{ id: 'one', label: 'One', onSelect: vi.fn() }]}
          trigger={props => <button type="button" {...props}>Actions</button>} />
      </Dialog>
    );
  }

  it('closes a tooltip inside a dialog before the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Layered onClose={onClose} />);
    const hinted = screen.getByRole('button', { name: 'Hinted' });
    expect(hinted).toHaveFocus();
    // Open by hover: jsdom's :focus-visible heuristic sticks after earlier pointer tests in this file.
    await user.hover(hinted);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Explains the action');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Layered' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes a menu inside a dialog before the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Layered onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'One' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

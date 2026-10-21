import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Menu, Popover, type MenuEntry } from './Menu';
import { skipMotion } from './testing';

beforeAll(skipMotion);

function setup(overrides: Partial<Record<string, () => void>> = {}) {
  const handlers = { light: vi.fn(), dark: vi.fn(), rotate: vi.fn(), logout: vi.fn(), ...overrides };
  const items: MenuEntry[] = [
    { type: 'label', id: 'theme', label: 'Theme' },
    { id: 'light', label: 'Light', checked: true, onSelect: handlers.light },
    { id: 'dark', label: 'Dark', checked: false, onSelect: handlers.dark },
    { type: 'separator', id: 'sep' },
    { id: 'export', label: 'Export', disabled: true, onSelect: vi.fn() },
    { id: 'rotate', label: 'Rotate link', onSelect: handlers.rotate },
    { id: 'logout', label: 'Sign out', danger: true, onSelect: handlers.logout }
  ];
  render(
    <>
      <Menu label="Account" items={items} trigger={props => <button type="button" {...props}>Account</button>} />
      <button type="button">outside</button>
    </>
  );
  return handlers;
}

describe('Menu', () => {
  it('opens from the trigger with ArrowDown and focuses the first item', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole('button', { name: 'Account' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveFocus();
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  });

  it('navigates with arrows, Home/End and typeahead, skipping disabled items', async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole('button', { name: 'Account' }).focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Rotate link' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveFocus();
    await user.keyboard('r');
    expect(screen.getByRole('menuitem', { name: 'Rotate link' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('selects with Enter, closes and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const trigger = screen.getByRole('button', { name: 'Account' });
    trigger.focus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(handlers.logout).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape (focus back to trigger) and on an outside click', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const trigger = screen.getByRole('button', { name: 'Account' });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'outside' }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(Object.values(handlers).every(handler => handler.mock.calls.length === 0)).toBe(true);
  });

  it('ignores clicks on disabled items', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('Popover', () => {
  it('moves focus inside, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    render(
      <Popover label="Details" trigger={props => <button type="button" {...props}>Details</button>}>
        {close => <button type="button" onClick={close}>Done</button>}
      </Popover>
    );
    const trigger = screen.getByRole('button', { name: 'Details' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

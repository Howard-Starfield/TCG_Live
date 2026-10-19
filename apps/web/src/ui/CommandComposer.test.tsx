import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandComposer, findActiveToken, type ComposerTrigger } from './CommandComposer';
import { skipMotion } from './testing';

beforeAll(skipMotion);

const commands = ['/publish', '/resolve', '/refresh'];
const triggers: ComposerTrigger[] = [
  { char: '/', atStart: true, label: 'Commands', getSuggestions: query => commands
    .filter(command => command.slice(1).startsWith(query))
    .map(command => ({ id: command, label: command, insertText: command })) },
  { char: '@', label: 'Members', getSuggestions: query => ['Gary', 'Brock']
    .filter(name => name.toLowerCase().startsWith(query.toLowerCase()))
    .map(name => ({ id: name, label: name, insertText: `@${name}` })) }
];

const textbox = () => screen.getByRole('textbox', { name: 'Command' }) as HTMLTextAreaElement;

describe('findActiveToken', () => {
  it('finds slash commands only at the start and mentions anywhere', () => {
    expect(findActiveToken('/res', 4, triggers)).toMatchObject({ query: 'res', start: 0, end: 4 });
    expect(findActiveToken('  /res', 6, triggers)).toMatchObject({ query: 'res', start: 2 });
    expect(findActiveToken('say /res', 8, triggers)).toBeNull();
    expect(findActiveToken('/resolve M2 @ga', 15, triggers)).toMatchObject({ query: 'ga', start: 12 });
    expect(findActiveToken('/resolve M2 ', 12, triggers)).toBeNull();
  });
});

describe('CommandComposer', () => {
  it('submits on Enter, adds a newline on Shift+Enter, and clears when uncontrolled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<CommandComposer onSubmit={onSubmit} />);
    await user.type(textbox(), 'hello{Shift>}{Enter}{/Shift}world');
    expect(textbox().value).toBe('hello\nworld');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('hello\nworld');
    expect(textbox().value).toBe('');
  });

  it('does not submit or select while an IME is composing', () => {
    const onSubmit = vi.fn();
    render(<CommandComposer onSubmit={onSubmit} triggers={triggers} />);
    const area = textbox();
    fireEvent.change(area, { target: { value: '/re', selectionStart: 3 } });
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument();

    // Enter that confirms a composition: isComposing on the native event.
    fireEvent.keyDown(area, { key: 'Enter', isComposing: true });
    // Some browsers report composition keys only as keyCode 229.
    fireEvent.keyDown(area, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(area, { key: 'ArrowDown', keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(area.value).toBe('/re');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');

    // Between compositionstart and compositionend every key belongs to the IME.
    fireEvent.compositionStart(area);
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(area.value).toBe('/re');
    fireEvent.compositionEnd(area);

    fireEvent.change(area, { target: { value: 'ready', selectionStart: 5 } });
    fireEvent.compositionStart(area);
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(area);
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('ready');
  });

  it('navigates suggestions with the arrow keys and inserts with Enter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<CommandComposer onSubmit={onSubmit} triggers={triggers} />);
    await user.type(textbox(), '/re');
    const options = screen.getAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual(['/resolve', '/refresh']);
    expect(textbox()).toHaveAttribute('aria-activedescendant', options[0]!.id);
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(textbox()).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(textbox().value).toBe('/refresh ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(textbox(), 'M2 @b');
    expect(screen.getByRole('listbox', { name: 'Members' })).toBeInTheDocument();
    await user.keyboard('{Tab}');
    expect(textbox().value).toBe('/refresh M2 @Brock ');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('/refresh M2 @Brock');
  });

  it('closes suggestions on Escape without clearing the text', async () => {
    const user = userEvent.setup();
    render(<CommandComposer onSubmit={vi.fn()} triggers={triggers} />);
    await user.type(textbox(), '/p');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textbox().value).toBe('/p');
  });

  it('blocks input and submit when disabled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<CommandComposer onSubmit={onSubmit} disabled defaultValue="/publish" />);
    expect(textbox()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits with the send button', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<CommandComposer onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(textbox(), '  /publish  ');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith('/publish');
  });
});

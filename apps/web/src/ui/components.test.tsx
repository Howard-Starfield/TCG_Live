import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Avatar, initialsOf } from './Avatar';
import { Button, IconButton } from './Button';
import { Disclosure } from './Disclosure';
import { Field, Input, Switch } from './Field';
import { skipMotion } from './testing';
import { Tooltip } from './Tooltip';

beforeAll(skipMotion);

describe('Field', () => {
  it('wires label, description and error to the control', () => {
    render(<Field label="Reason" description="Shown in the audit log." error="Required." required><Input /></Field>);
    const input = screen.getByRole('textbox', { name: /reason/i });
    expect(input).toHaveAccessibleDescription('Shown in the audit log. Required.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toBeRequired();
  });

  it('labels a switch and toggles aria-checked', async () => {
    const user = userEvent.setup();
    function Toggle() {
      const [on, setOn] = useState(false);
      return <Field label="Notifications" inline><Switch checked={on} onCheckedChange={setOn} /></Field>;
    }
    render(<Toggle />);
    const control = screen.getByRole('switch', { name: 'Notifications' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    await user.click(control);
    expect(control).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Avatar', () => {
  it('falls back to initials when the image fails or is missing', () => {
    const { rerender } = render(<Avatar src="https://cdn.discordapp.com/avatars/1/a.png" name="Gary Oak" />);
    const image = screen.getByRole('img', { name: 'Gary Oak' });
    fireEvent.error(image.querySelector('img')!);
    expect(screen.getByRole('img', { name: 'Gary Oak' })).toHaveTextContent('GO');
    rerender(<Avatar src={null} name={null} />);
    expect(screen.getByRole('img', { name: 'Unknown member' })).toHaveTextContent('?');
    expect(initialsOf('  brock ')).toBe('B');
  });
});

describe('Button', () => {
  it('blocks clicks and reports busy while loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<><Button loading onClick={onClick}>Save</Button><IconButton aria-label="Close" icon={<span />} /></>);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-busy', 'true');
    await user.click(save);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });
});

describe('Tooltip', () => {
  it('describes its trigger on keyboard focus and hides on Escape', async () => {
    const user = userEvent.setup();
    render(<Tooltip content="Copies the event id"><button type="button">Copy</button></Tooltip>);
    await user.tab();
    const tip = await screen.findByRole('tooltip');
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveAccessibleDescription('Copies the event id');
    expect(tip).toHaveTextContent('Copies the event id');
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});

describe('Disclosure', () => {
  it('toggles aria-expanded and its region', async () => {
    const user = userEvent.setup();
    render(<Disclosure summary="Raw entry"><p>payload</p></Disclosure>);
    const button = screen.getByRole('button', { name: /raw entry/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(button.getAttribute('aria-controls')!)).toHaveTextContent('payload');
  });
});

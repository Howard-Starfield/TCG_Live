import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';
import { TabPanel, TabStrip, ToggleTab } from './Tabs';
import { skipMotion } from './testing';

beforeAll(skipMotion);

type TabValue = 'players' | 'matches' | 'audit' | 'panels';

function Tabs({ onChange }: { onChange?: (value: TabValue) => void }) {
  const [value, setValue] = useState<TabValue>('players');
  return (
    <>
      <TabStrip label="Lists" idBase="lists" value={value}
        onChange={next => { setValue(next); onChange?.(next); }}
        tabs={[
          { value: 'players', label: 'Players' },
          { value: 'matches', label: 'Matches' },
          { value: 'audit', label: 'Audit', disabled: true },
          { value: 'panels', label: 'Panels' }
        ]} />
      <TabPanel idBase="lists" value={value}>Panel for {value}</TabPanel>
    </>
  );
}

describe('TabStrip', () => {
  it('exposes tablist semantics with exactly one tabbable tab', () => {
    render(<Tabs />);
    const list = screen.getByRole('tablist', { name: 'Lists' });
    expect(list).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', tabs[0]!.id);
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
  });

  it('moves focus and selection with the arrow keys, skipping disabled tabs and wrapping', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Players' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Matches' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Matches' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Panels' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Players' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Panels' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Players' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Panels' })).toHaveFocus();

    expect(onChange).toHaveBeenCalledWith('matches');
    expect(onChange).not.toHaveBeenCalledWith('audit');
    expect(screen.getAllByRole('tab').map(tab => tab.tabIndex)).toEqual([-1, -1, -1, 0]);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel for panels');
  });

  it('returns Tab focus to the selected tab', async () => {
    const user = userEvent.setup();
    render(<><Tabs /><button type="button">after</button></>);
    await user.click(screen.getByRole('tab', { name: 'Matches' }));
    await user.tab();
    expect(screen.getByRole('tabpanel')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('tab', { name: 'Matches' })).toHaveFocus();
  });
});

describe('ToggleTab', () => {
  it('reports its state with aria-pressed and toggles on click', async () => {
    const user = userEvent.setup();
    function Toggle() {
      const [pressed, setPressed] = useState(false);
      return <ToggleTab pressed={pressed} onPressedChange={setPressed} shortcut={['Alt', '1']}>Live preview</ToggleTab>;
    }
    render(<Toggle />);
    const button = screen.getByRole('button', { name: /live preview/i });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Alt+1');
    await user.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('SegmentedControl', () => {
  it('is a radio group whose arrow keys change the value', async () => {
    const user = userEvent.setup();
    function Segments() {
      const [value, setValue] = useState<'event' | 'match' | 'rounds'>('event');
      return <SegmentedControl label="View" value={value} onChange={setValue}
        options={[{ value: 'event', label: 'Event' }, { value: 'match', label: 'Match' }, { value: 'rounds', label: 'Rounds', disabled: true }]} />;
    }
    render(<Segments />);
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Event' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Match' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Event' })).toHaveAttribute('aria-checked', 'true');
  });
});

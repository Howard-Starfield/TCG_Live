import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useResolvedTheme, type ThemePreference } from './ThemeProvider';
import { mockMatchMedia } from './testing';

const DARK = '(prefers-color-scheme: dark)';
let media: ReturnType<typeof mockMatchMedia> | null = null;
afterEach(() => { media?.restore(); media = null; document.documentElement.classList.remove('dark'); });

function Resolved() {
  return <span data-testid="resolved">{useResolvedTheme()}</span>;
}

const html = () => document.documentElement;

describe('ThemeProvider', () => {
  it('adds and removes .dark on <html> for explicit themes', () => {
    media = mockMatchMedia({ [DARK]: false });
    const { rerender, unmount } = render(<ThemeProvider theme="dark"><Resolved /></ThemeProvider>);
    expect(html()).toHaveClass('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    rerender(<ThemeProvider theme="light"><Resolved /></ThemeProvider>);
    expect(html()).not.toHaveClass('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    rerender(<ThemeProvider theme="dark"><Resolved /></ThemeProvider>);
    unmount();
    expect(html()).not.toHaveClass('dark');
  });

  it('follows the system setting in system mode, live', () => {
    media = mockMatchMedia({ [DARK]: true });
    render(<ThemeProvider theme={'system' as ThemePreference}><Resolved /></ThemeProvider>);
    expect(html()).toHaveClass('dark');
    act(() => media!.set(DARK, false));
    expect(html()).not.toHaveClass('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    act(() => media!.set(DARK, true));
    expect(html()).toHaveClass('dark');
  });

  it('can target a scoped element instead of <html>', () => {
    media = mockMatchMedia({});
    const box = document.createElement('div');
    render(<ThemeProvider theme="dark" target={box}><Resolved /></ThemeProvider>);
    expect(box).toHaveClass('dark');
    expect(html()).not.toHaveClass('dark');
  });
});

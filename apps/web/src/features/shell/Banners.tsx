import { Archive, Database, KeyRound, LoaderCircle, RefreshCw, Snowflake, TriangleAlert, WifiOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useServerNow, useStreamConnection } from '../../data';
import { Button, cx, springs, useSafeTransition } from '../../ui';
import { hasInterruptedClock } from './labels';
import { useShell } from './model';

export type BannerTone = 'neutral' | 'warning' | 'danger';

export interface BannerSpec {
  id: string;
  tone: BannerTone;
  icon: ReactNode;
  title: string;
  body?: string;
  /** Changing detail (a countdown): shown, but kept out of the live region so it is not re-announced. */
  ticker?: string;
  action?: { label: string; onClick: () => void };
}

/** Status banners under the top bar: stream, lease, database, clocks, cards, retired view. */
export function Banners() {
  const shell = useShell();
  const connection = useStreamConnection();
  useServerNow(connection.retryAtMs ? 1000 : null);
  const transition = useSafeTransition(springs.pane);
  const { status, viewed } = shell;
  const banners: BannerSpec[] = [];

  if (connection.state === 'offline') {
    banners.push({ id: 'offline', tone: 'danger', icon: <WifiOff />, title: 'You are offline.',
      body: 'Live updates resume when the network returns. What you see may be out of date.',
      action: { label: 'Retry now', onClick: connection.reconnect } });
  } else if (connection.state === 'reconnecting') {
    const retryIn = connection.retryAtMs ? Math.max(0, Math.ceil((connection.retryAtMs - Date.now()) / 1000)) : null;
    banners.push({ id: 'reconnecting', tone: 'warning', icon: <LoaderCircle className="animate-spin" />,
      title: 'Reconnecting to the live stream…',
      body: 'The console shows the last state it received.',
      ...(retryIn ? { ticker: `Next attempt in ${retryIn}s.` } : {}),
      action: { label: 'Retry now', onClick: connection.reconnect } });
  }
  if (status?.lease === 'lost') {
    banners.push({ id: 'lease', tone: 'danger', icon: <KeyRound />, title: 'This bot lost the session lease.',
      body: 'Another process now owns the event. Cards and clocks are not driven from here until the lease is back.' });
  }
  if (status?.database === 'unavailable') {
    banners.push({ id: 'database', tone: 'danger', icon: <Database />, title: 'PostgreSQL is unavailable.',
      body: 'Event data cannot be read or saved right now; the console keeps showing the last state it read.' });
  }
  if (!viewed.retired && hasInterruptedClock(viewed.snapshot)) {
    banners.push({ id: 'interrupted', tone: 'warning', icon: <Snowflake />,
      title: 'A running clock belongs to another process…',
      body: 'It is shown frozen and labelled interrupted. It keeps counting only in the process that owns it; nothing here changes it.' });
  }
  if (status?.cards.updatePending) {
    banners.push({ id: 'cards', tone: 'neutral', icon: <RefreshCw />, title: 'Discord cards update pending.',
      body: 'Changes are saved; the cards in Discord catch up when the next refresh succeeds.' });
  }
  if (status?.rooms.warning) {
    banners.push({ id: 'rooms', tone: 'warning', icon: <TriangleAlert />, title: 'Match rooms need attention.', body: status.rooms.warning });
  }
  if (viewed.retired) {
    banners.push({ id: 'retired', tone: 'neutral', icon: <Archive />, title: 'Retired event · read-only history.',
      body: 'Nothing here changes any more.',
      ...(shell.activeEventId ? { action: { label: 'Back to the live event', onClick: shell.followActive } } : {}) });
  }

  return (
    <div className="shell-banners" aria-label="Status" role="region">
      <AnimatePresence initial={false}>
        {banners.map(banner => (
          <motion.div key={banner.id} layout="position" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }} transition={transition} className="overflow-hidden">
            <Banner banner={banner} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Banner({ banner }: { banner: BannerSpec }) {
  return (
    <div data-banner={banner.id} data-tone={banner.tone} className={cx('shell-banner', `is-${banner.tone}`)}>
      <span aria-hidden className="shell-banner-icon">{banner.icon}</span>
      <p className="min-w-0 flex-1">
        <span role={banner.tone === 'danger' ? 'alert' : 'status'} data-banner-message="">
          <span className="font-semibold text-fg">{banner.title}</span>
          {banner.body && <span className="text-fg-muted"> {banner.body}</span>}
        </span>
        {banner.ticker && <span aria-hidden className="text-fg-muted tabular-nums" data-banner-ticker=""> {banner.ticker}</span>}
      </p>
      {banner.action && <Button size="sm" variant="ghost" onClick={banner.action.onClick}>{banner.action.label}</Button>}
    </div>
  );
}

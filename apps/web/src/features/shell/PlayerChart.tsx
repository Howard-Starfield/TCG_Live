import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { EventSnapshotDto } from '@tcg-live/core';

interface ChartRow { label: string; value: number; color: string }

const MOTION = { isAnimationActive: 'auto', animationDuration: 400, animationEasing: 'ease' } as const;

function ChartDetails({ row, capacity }: { row: ChartRow; capacity: number }) {
  return <div className="home-chart-tooltip">
    <strong>{row.label}</strong>
    <span><i style={{ background: row.color }} aria-hidden="true" />{row.value} of {capacity} seats</span>
  </div>;
}

export default function PlayerChart({ snapshot }: { snapshot: EventSnapshotDto }) {
  const [view, setView] = useState<'bar' | 'donut'>('bar');
  const seats = Object.values(snapshot.seats);
  const assigned = seats.filter(seat => seat !== null).length;
  const capacity = snapshot.signup?.capacity ?? seats.length;
  const joined = snapshot.signup?.roster.length ?? assigned;
  const checkedIn = snapshot.checkins.length;
  const signup = snapshot.stage === 'signup';
  const counts = [
    { label: 'Joined', value: joined, color: 'var(--color-fg-muted)' },
    { label: 'Assigned', value: assigned, color: 'var(--color-accent-fill)' },
    { label: 'Checked in', value: checkedIn, color: 'var(--color-success)' }
  ];
  const breakdown = [
    { label: 'Checked in', value: checkedIn, color: 'var(--color-success)' },
    { label: 'Assigned, awaiting check-in', value: assigned - checkedIn, color: 'var(--color-accent-fill)' },
    { label: 'Joined, awaiting assignment', value: joined - assigned, color: 'var(--color-fg-muted)' },
    { label: 'Open seats', value: capacity - joined, color: 'var(--color-line-strong)' }
  ].filter(row => row.value > 0);
  const renderDetails = (active: boolean | undefined, rows: ChartRow[], label: string | number | undefined) => {
    const row = active ? rows.find(item => item.label === label) : undefined;
    return row ? <ChartDetails row={row} capacity={capacity} /> : null;
  };

  return <>
    <div className="home-chart-heading">
      <p className="home-card-count"><strong>{signup ? joined : assigned}</strong><span> of {capacity} {signup ? 'joined' : 'assigned'}</span></p>
      <div className="home-chart-toggle" role="group" aria-label="Player chart view">
        <button type="button" aria-pressed={view === 'bar'} onClick={() => setView('bar')}>Bar</button>
        <button type="button" aria-pressed={view === 'donut'} onClick={() => setView('donut')}>Donut</button>
      </div>
    </div>
    <ul className="sr-only" aria-label="Player counts">
      {counts.map(row => <li key={row.label}><span>{row.label}</span><strong>{row.value}</strong></li>)}
    </ul>
    <div className="home-player-chart" data-view={view}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 260, height: 158 }}>
        {view === 'bar' ? <BarChart data={counts} accessibilityLayer margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-line-strong)" strokeDasharray="2 4" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={8}
            tick={{ fontSize: 11, fill: 'var(--color-fg-muted)' }} />
          <YAxis domain={[0, capacity]} ticks={Array.from({ length: capacity + 1 }, (_, i) => i)}
            allowDecimals={false} axisLine={false} tickLine={false} width={23}
            tick={{ fontSize: 10, fill: 'var(--color-fg-muted)' }} />
          <Tooltip {...MOTION} cursor={{ fill: 'var(--color-line-faint)' }}
            content={({ active, label }) => renderDetails(active, counts, label)} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={25} {...MOTION}>
            {counts.map(row => <Cell key={row.label} fill={row.color} />)}
          </Bar>
        </BarChart> : <PieChart accessibilityLayer>
          <Pie data={breakdown} dataKey="value" nameKey="label" innerRadius={43} outerRadius={65}
            paddingAngle={breakdown.length > 1 ? 2 : 0} stroke="none" {...MOTION}>
            {breakdown.map(row => <Cell key={row.label} fill={row.color} />)}
          </Pie>
          <Tooltip {...MOTION} content={({ active, payload }) => renderDetails(active, breakdown, payload[0]?.name)} />
        </PieChart>}
      </ResponsiveContainer>
      {view === 'donut' && <div className="home-donut-center" aria-hidden="true">
        <strong>{capacity - joined}</strong><span>open seats</span>
      </div>}
    </div>
    {view === 'donut' && <ul className="home-chart-legend" aria-label="Seat breakdown">
      {breakdown.map(row => <li key={row.label}><i style={{ background: row.color }} aria-hidden="true" />{row.label} <strong>{row.value}</strong></li>)}
    </ul>}
  </>;
}

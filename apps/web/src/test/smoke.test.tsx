// Wave 0 toolchain smoke test: every runtime library imports, and jsdom renders React, React Flow and motion.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatClock, remainingMsAt, CAPABILITIES } from '@tcg-live/core';
import { liveDispute } from '@tcg-live/core/fixtures';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { Activity } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

describe('toolchain smoke', () => {
  it('imports the shared core contract from source', () => {
    expect(CAPABILITIES).toContain('dashboard.read');
    const clock = liveDispute.matches[0]!.clock;
    expect(formatClock(remainingMsAt(clock, clock.runningSinceMs! + 60_000))).toBe('49:00');
  });

  it('renders React, motion, lucide and React Query, and handles user events', async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <motion.button type="button" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={() => setCount(c => c + 1)}>
          <Activity aria-hidden /> Count {count}
        </motion.button>
      );
    }
    render(<QueryClientProvider client={new QueryClient()}><Counter /></QueryClientProvider>);
    await userEvent.click(screen.getByRole('button', { name: /count 0/i }));
    expect(screen.getByRole('button')).toHaveTextContent('Count 1');
  });

  it('renders a React Flow canvas with nodes', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow nodes={[{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'Signup' } },
            { id: 'b', position: { x: 200, y: 0 }, data: { label: 'Check-in' } }]}
          edges={[{ id: 'a-b', source: 'a', target: 'b' }]} />
        </div>
      </ReactFlowProvider>
    );
    expect(screen.getByText('Signup')).toBeInTheDocument();
    expect(screen.getByText('Check-in')).toBeInTheDocument();
  });
});

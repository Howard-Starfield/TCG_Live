import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';

const root = createRoot(document.getElementById('root')!);

async function mount(): Promise<void> {
  // Dev galleries (#/__kit, #/__flow) are excluded from production builds: import.meta.env.DEV is
  // statically false there, so the dynamic import below is dropped.
  if (import.meta.env.DEV) {
    const { resolveGallery } = await import('./dev/registry');
    const Gallery = resolveGallery(window.location.hash);
    if (Gallery) {
      root.render(<StrictMode><Gallery /></StrictMode>);
      window.addEventListener('hashchange', () => window.location.reload(), { once: true });
      return;
    }
  }
  const { App } = await import('./App');
  root.render(<StrictMode><App /></StrictMode>);
}

void mount();

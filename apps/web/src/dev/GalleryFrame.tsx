import { Suspense, type ReactNode } from 'react';

/** Shared wrapper so every gallery renders the same content in light and dark side by side. */
export function GalleryFrame({ title, children }: { title: string; children: () => ReactNode }) {
  return (
    <Suspense fallback={null}>
      <div className="grid min-h-full grid-cols-1 xl:grid-cols-2">
        {(['light', 'dark'] as const).map(theme => (
          <section key={theme} className={`${theme === 'dark' ? 'dark' : ''} bg-base p-6 text-fg`} data-theme={theme}>
            <h1 className="mb-4 text-lg font-semibold">{title} · {theme}</h1>
            {children()}
          </section>
        ))}
      </div>
    </Suspense>
  );
}

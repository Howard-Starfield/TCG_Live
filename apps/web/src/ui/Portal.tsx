import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const PortalContext = createContext<HTMLElement | null>(null);

/**
 * Renders overlays (dialogs, menus, tooltips, toasts) into a container inside this subtree instead of
 * `document.body`, so they inherit a scoped theme (the kit gallery renders a `.dark` section this way).
 */
export function PortalScope({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <PortalContext.Provider value={container}>
      {children}
      <div ref={setContainer} data-portal-scope="" />
    </PortalContext.Provider>
  );
}

export function usePortalContainer(): HTMLElement | null {
  const scoped = useContext(PortalContext);
  return scoped ?? (typeof document === 'undefined' ? null : document.body);
}

export function Portal({ children }: { children: ReactNode }) {
  const container = usePortalContainer();
  return container ? createPortal(children, container) : null;
}

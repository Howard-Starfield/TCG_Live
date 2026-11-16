// Pop-up editor shared by the Admin tools creation flows: form on the left, optional live preview on the right,
// a scrolling body with the actions pinned below, and a guard against losing unsaved edits.
import { useEffect, useState, type ReactNode } from 'react';
import { ConfirmDialog, Dialog } from '../../../ui';

export interface EditorDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  /** The form. */
  children: ReactNode;
  /** Live preview shown beside the form (below it on narrow screens). */
  preview?: ReactNode;
  /** Action buttons, right-aligned and always visible. */
  footer?: ReactNode;
  /** Something is being saved: the dialog cannot be dismissed. */
  busy?: boolean;
  /** Unsaved edits: dismissing asks for confirmation first. */
  dirty?: boolean;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  onClose: () => void;
}

export function EditorDialog({ open, title, description, children, preview, footer, busy = false, dirty = false, width, onClose }: EditorDialogProps) {
  const [confirming, setConfirming] = useState(false);
  // Discard closes the confirm first and the editor one commit later: closing both together lets the confirm hand
  // focus back into the closing editor, and focus then falls to <body> instead of the button that opened it.
  const [discarding, setDiscarding] = useState(false);
  useEffect(() => {
    if (!discarding || confirming) return;
    setDiscarding(false);
    onClose();
  }, [discarding, confirming, onClose]);
  const request = () => {
    if (busy) return;
    if (dirty) setConfirming(true); else onClose();
  };
  return <>
    <Dialog open={open} onClose={request} title={title} description={description} footer={footer} dismissible={!busy}
      width={width ?? (preview ? 'xl' : 'lg')}>
      {preview
        ? <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">{children}</div>
          <section aria-labelledby="editor-preview-heading" className="min-w-0">
            <h3 id="editor-preview-heading" className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Preview</h3>
            {preview}
          </section>
        </div>
        : children}
    </Dialog>
    <ConfirmDialog open={open && confirming} danger title="Discard unsaved changes?" confirmLabel="Discard" cancelLabel="Keep editing"
      description="What you entered here has not been saved."
      onCancel={() => setConfirming(false)}
      onConfirm={() => { setConfirming(false); setDiscarding(true); }} />
  </>;
}

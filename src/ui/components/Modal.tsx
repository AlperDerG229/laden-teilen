import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Native <dialog>: focus trap, Esc and backdrop come for free. Children render only while open. */
export function Modal({ open, onClose, title, children, testId }: { open: boolean; onClose: () => void; title: string; children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      data-testid={open ? testId : undefined}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // backdrop click
      }}
    >
      {open && (
        <>
          <div className="modal__head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
          <div className="modal__body">{children}</div>
        </>
      )}
    </dialog>
  );
}

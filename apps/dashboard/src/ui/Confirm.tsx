import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Button } from './Button.js';
import { Modal } from './Modal.js';

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
interface Pending { opts: ConfirmOptions; resolve: (ok: boolean) => void }

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Promise-based confirm dialog: `if (await confirm({...})) doIt()`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => {
    setPending({ opts, resolve });
  }), []);

  const settle = useCallback((ok: boolean) => {
    setPending((p) => {
      p?.resolve(ok);
      return null;
    });
  }, []);
  const cancel = useCallback(() => settle(false), [settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={pending !== null}
        title={pending?.opts.title ?? ''}
        onClose={cancel}
        width="sm"
        footer={(
          <>
            <Button onClick={cancel}>Cancel</Button>
            <Button variant={pending?.opts.danger ? 'danger' : 'primary'} onClick={() => settle(true)} autoFocus>
              {pending?.opts.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        )}
      >
        <div className="confirm-message">{pending?.opts.message}</div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}

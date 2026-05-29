"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface UseDialogOptions {
  open: boolean;
  onClose?: () => void;
  // When false, Escape does not close the dialog — for gates that must be
  // answered rather than dismissed (e.g. the age gate). Focus-trap, scroll
  // lock, and focus restoration still apply.
  dismissible?: boolean;
}

/**
 * Shared dialog accessibility: focus trap, body scroll lock, initial focus,
 * and focus restoration to the trigger on close. `ui/Modal` is built on this;
 * components with bespoke chrome (CheckoutOverlay, AgeGate) attach the returned
 * ref to their dialog element to inherit the same behavior.
 */
export function useDialog({ open, onClose, dismissible = true }: UseDialogOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);

  // Keep the latest onClose without re-running the effect.
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (dismissible) onCloseRef.current?.();
        return;
      }

      if (e.key !== "Tab" || !dialogRef.current) return;

      const focusable = dialogRef.current.querySelectorAll(FOCUSABLE);
      if (focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    triggerRef.current = document.activeElement;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    requestAnimationFrame(() => {
      if (dialogRef.current) {
        const first = dialogRef.current.querySelector(FOCUSABLE) as HTMLElement | null;
        if (first) first.focus();
        else dialogRef.current.focus();
      }
    });

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    };
  }, [open, dismissible]);

  return dialogRef;
}

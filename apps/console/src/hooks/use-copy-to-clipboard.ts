import { useEffect, useRef, useState } from "react";

export function useCopyToClipboard({
  timeout = 2000,
  onCopy,
  onError,
}: {
  timeout?: number;
  onCopy?: () => void;
  onError?: ((error: unknown) => void) | undefined;
} = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copyToClipboard = (value: string) => {
    if (typeof window === "undefined" || !navigator.clipboard.writeText) {
      return;
    }

    if (!value) return;

    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);

      if (onCopy) {
        onCopy();
      }

      if (timeout !== 0) {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setIsCopied(false);
        }, timeout);
      }
    }, onError ?? console.error);
  };

  return { isCopied, copyToClipboard };
}

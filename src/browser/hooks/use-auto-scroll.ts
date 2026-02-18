import { useEffect, useRef } from "react";

const SCROLL_THRESHOLD = 40;

export function useAutoScroll(contentLen: number) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevContentLenRef = useRef(0);

  useEffect(() => {
    if (contentLen > prevContentLenRef.current) {
      if (autoScrollRef.current && viewportRef.current) {
        viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
      }
    }
    prevContentLenRef.current = contentLen;
  }, [contentLen]);

  function handleScroll() {
    if (!viewportRef.current) return;
    const el = viewportRef.current;
    autoScrollRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  }

  return { viewportRef, handleScroll };
}

import { useCallback, useEffect, useRef, useState } from "react";

export interface DockLayout {
  mediaWidth: number;
  inspectorWidth: number;
  chatWidth: number;
  timelineVh: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

const STORAGE_KEY = "monet-dock-layout-v1";

const readStoredLayout = (): Partial<DockLayout> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<DockLayout>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Persisted sizes for the Monet shell's resizable docks. Mirrors the numeric
 * state already driven by EditorInterface's resize handles and writes a
 * debounced snapshot to localStorage so widths/heights survive reloads.
 * Layout is presentation state — it never touches the project document.
 */
export function useDockLayout(defaults: DockLayout) {
  const stored = useRef<Partial<DockLayout>>(readStoredLayout());

  const [layout, setLayout] = useState<DockLayout>(() => ({
    mediaWidth: clamp(stored.current.mediaWidth ?? defaults.mediaWidth, 0, Number.MAX_SAFE_INTEGER),
    inspectorWidth: clamp(stored.current.inspectorWidth ?? defaults.inspectorWidth, 0, Number.MAX_SAFE_INTEGER),
    chatWidth: clamp(stored.current.chatWidth ?? defaults.chatWidth, 0, Number.MAX_SAFE_INTEGER),
    timelineVh: clamp(stored.current.timelineVh ?? defaults.timelineVh, 0, 100),
    leftCollapsed: Boolean(stored.current.leftCollapsed),
    rightCollapsed: Boolean(stored.current.rightCollapsed),
  }));

  const persistTimer = useRef<number | null>(null);

  useEffect(() => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
      } catch {
        /* storage unavailable — layout persistence is best-effort */
      }
    }, 250);
    return () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    };
  }, [layout]);

  const setMediaWidth = useCallback((v: number | ((p: number) => number)) => {
    setLayout((prev) => ({
      ...prev,
      mediaWidth: typeof v === "function" ? v(prev.mediaWidth) : v,
    }));
  }, []);

  const setInspectorWidth = useCallback((v: number | ((p: number) => number)) => {
    setLayout((prev) => ({
      ...prev,
      inspectorWidth: typeof v === "function" ? v(prev.inspectorWidth) : v,
    }));
  }, []);

  const setChatWidth = useCallback((v: number | ((p: number) => number)) => {
    setLayout((prev) => ({
      ...prev,
      chatWidth: typeof v === "function" ? v(prev.chatWidth) : v,
    }));
  }, []);

  const setTimelineVh = useCallback((v: number | ((p: number) => number)) => {
    setLayout((prev) => ({
      ...prev,
      timelineVh: typeof v === "function" ? v(prev.timelineVh) : v,
    }));
  }, []);

  const toggleLeftCollapsed = useCallback(() => {
    setLayout((prev) => ({ ...prev, leftCollapsed: !prev.leftCollapsed }));
  }, []);

  const toggleRightCollapsed = useCallback(() => {
    setLayout((prev) => ({ ...prev, rightCollapsed: !prev.rightCollapsed }));
  }, []);

  return {
    layout,
    setMediaWidth,
    setInspectorWidth,
    setChatWidth,
    setTimelineVh,
    toggleLeftCollapsed,
    toggleRightCollapsed,
  };
}

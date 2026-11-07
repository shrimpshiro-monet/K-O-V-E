/**
 * Native HTMLVideoElements advance on the browser's media clock. A seek is only
 * needed when playback enters a different timeline segment; seeking on every
 * animation frame repeatedly stalls the decoder waiting for `seeked`.
 */
export function shouldSeekNativePlaybackSegment(
  currentSegmentKey: string | null,
  nextSegmentKey: string,
): boolean {
  return currentSegmentKey !== nextSegmentKey;
}

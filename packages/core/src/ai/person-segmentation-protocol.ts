export interface SegmentationWorkerInitRequest {
  type: "init";
  /**
   * Resolved asset locations. Required (rather than optional with defaults)
   * because the worker is a classic script that must not import runtime
   * modules — see the note in `person-segmentation-worker.ts`.
   */
  assets: VisionAssetUrls;
}

export interface SegmentationWorkerFrameRequest {
  type: "segment";
  requestId: number;
  streamId: string;
  timestampMs: number;
  bitmap: ImageBitmap;
  reset: boolean;
}

export interface SegmentationWorkerDisposeRequest {
  type: "dispose";
}

import type { VisionAssetUrls } from "./vision-assets";

export type SegmentationWorkerRequest =
  | SegmentationWorkerInitRequest
  | SegmentationWorkerFrameRequest
  | SegmentationWorkerDisposeRequest;

export interface SegmentationWorkerReadyResponse {
  type: "ready";
}

export interface SegmentationWorkerResultResponse {
  type: "result";
  requestId: number;
  streamId: string;
  timestampMs: number;
  width: number;
  height: number;
  alpha: Uint8ClampedArray;
  referenceRgba: Uint8ClampedArray;
  referenceWidth: number;
  referenceHeight: number;
}

export interface SegmentationWorkerErrorResponse {
  type: "error";
  requestId?: number;
  streamId?: string;
  message: string;
}

export type SegmentationWorkerResponse =
  | SegmentationWorkerReadyResponse
  | SegmentationWorkerResultResponse
  | SegmentationWorkerErrorResponse;

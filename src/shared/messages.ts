/**
 * Message types for communication between extension components
 */

import { VideoMetadata, DownloadStage } from "../core/types";
import type {
  ClipDraft,
  ClipDraftLocator,
  ClipMarkUpdate,
  PlaybackCandidate,
} from "../core/playback/types";
import type { ClipRequest } from "../core/clipping/types";

export type CloudProvider = 'googleDrive' | 's3';

export enum MessageType {
  // Download messages
  DOWNLOAD_REQUEST = "DOWNLOAD_REQUEST",
  DOWNLOAD_PROGRESS = "DOWNLOAD_PROGRESS",
  DOWNLOAD_COMPLETE = "DOWNLOAD_COMPLETE",
  DOWNLOAD_FAILED = "DOWNLOAD_FAILED",
  CANCEL_DOWNLOAD = "CANCEL_DOWNLOAD",
  CLIP_REQUEST = "CLIP_REQUEST",

  // State messages
  GET_DOWNLOADS = "GET_DOWNLOADS",
  CLEAR_DOWNLOADS = "CLEAR_DOWNLOADS",

  // Video detection
  VIDEO_DETECTED = "VIDEO_DETECTED",
  VIDEO_REMOVED = "VIDEO_REMOVED",
  GET_DETECTED_VIDEOS = "GET_DETECTED_VIDEOS",
  START_DOWNLOAD = "START_DOWNLOAD",
  EXTRACT_VIDEO_URL = "EXTRACT_VIDEO_URL",
  NETWORK_URL_DETECTED = "NETWORK_URL_DETECTED",

  // Page playback and clip drafts
  GET_PLAYBACK_CANDIDATES = "GET_PLAYBACK_CANDIDATES",
  GET_CLIP_DRAFT = "GET_CLIP_DRAFT",
  SET_CLIP_MARK = "SET_CLIP_MARK",
  CLEAR_CLIP_DRAFT = "CLEAR_CLIP_DRAFT",

  // Cloud upload
  UPLOAD_REQUEST = "UPLOAD_REQUEST",
  UPLOAD_PROGRESS = "UPLOAD_PROGRESS",
  UPLOAD_COMPLETE = "UPLOAD_COMPLETE",
  UPLOAD_FAILED = "UPLOAD_FAILED",
  CANCEL_UPLOAD = "CANCEL_UPLOAD",

  // Config
  GET_CONFIG = "GET_CONFIG",
  SAVE_CONFIG = "SAVE_CONFIG",

  // Auth
  AUTH_REQUEST = "AUTH_REQUEST",
  AUTH_COMPLETE = "AUTH_COMPLETE",
  AUTH_FAILED = "AUTH_FAILED",

  // Fetch resource (for CORS bypass in content scripts)
  FETCH_RESOURCE = "FETCH_RESOURCE",

  // Offscreen messages
  OFFSCREEN_PROCESS_HLS = "OFFSCREEN_PROCESS_HLS",
  OFFSCREEN_PROCESS_HLS_RESPONSE = "OFFSCREEN_PROCESS_HLS_RESPONSE",
  OFFSCREEN_PROCESS_M3U8 = "OFFSCREEN_PROCESS_M3U8",
  OFFSCREEN_PROCESS_M3U8_RESPONSE = "OFFSCREEN_PROCESS_M3U8_RESPONSE",
  OFFSCREEN_PROCESS_DASH = "OFFSCREEN_PROCESS_DASH",
  OFFSCREEN_PROCESS_DASH_RESPONSE = "OFFSCREEN_PROCESS_DASH_RESPONSE",
  OFFSCREEN_PROCESS_MEDIABUNNY_CLIP = "OFFSCREEN_PROCESS_MEDIABUNNY_CLIP",
  OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE = "OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE",
  OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP = "OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP",
  OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP_RESPONSE = "OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP_RESPONSE",
  OFFSCREEN_CANCEL_MEDIA_JOB = "OFFSCREEN_CANCEL_MEDIA_JOB",

  // Icon management
  SET_ICON_BLUE = "SET_ICON_BLUE",
  SET_ICON_GRAY = "SET_ICON_GRAY",

  // Live recording
  START_RECORDING = "START_RECORDING",
  STOP_RECORDING = "STOP_RECORDING",

  // Stop and save partial download
  STOP_AND_SAVE_DOWNLOAD = "STOP_AND_SAVE_DOWNLOAD",

  // Blob URL revocation (must be sent to offscreen document — not service worker)
  REVOKE_BLOB_URL = "REVOKE_BLOB_URL",

  // FFmpeg pre-warm
  WARMUP_FFMPEG = "WARMUP_FFMPEG",

  // URL health check (options page manifest check feature)
  CHECK_URL = "CHECK_URL",
}

export interface BaseMessage {
  type: MessageType;
  payload?: any;
}

export interface DownloadRequestMessage extends BaseMessage {
  type: MessageType.DOWNLOAD_REQUEST;
  payload: {
    url: string;
    filename?: string;
    metadata: VideoMetadata;
    tabTitle?: string;
    website?: string;
  };
}

export interface DownloadProgressMessage extends BaseMessage {
  type: MessageType.DOWNLOAD_PROGRESS;
  payload: {
    id: string;
    progress: {
      stage: DownloadStage;
      downloaded?: number;
      total?: number;
      percentage?: number;
      message?: string;
    };
  };
}

export interface ClipRequestMessage extends BaseMessage {
  type: MessageType.CLIP_REQUEST;
  payload: ClipRequest;
}

export interface GetPlaybackCandidatesMessage extends BaseMessage {
  type: MessageType.GET_PLAYBACK_CANDIDATES;
  payload?: {
    tabId?: number;
    pageVideoId?: string;
  };
}

export interface PlaybackCandidatesMessageResponse {
  success: boolean;
  candidates: PlaybackCandidate[];
  error?: string;
}

export interface GetClipDraftMessage extends BaseMessage {
  type: MessageType.GET_CLIP_DRAFT;
  payload: { locator: ClipDraftLocator };
}

export interface SetClipMarkMessage extends BaseMessage {
  type: MessageType.SET_CLIP_MARK;
  payload: ClipMarkUpdate;
}

export interface ClearClipDraftMessage extends BaseMessage {
  type: MessageType.CLEAR_CLIP_DRAFT;
  payload: { locator: ClipDraftLocator };
}

export interface ClipDraftMessageResponse {
  success: boolean;
  draft: ClipDraft | null;
  error?: string;
}

/** IDB-backed offscreen request; binary media data is never serialized here. */
export interface FastSegmentedClipPayload {
  downloadId: string;
  mediaFormat: "hls-ts" | "hls-fmp4" | "dash-fmp4";
  inputKind: "combined" | "separate";
  durationMs: number;
  combinedLength?: number;
  combinedRelativeStartMs?: number;
  videoLength?: number;
  audioLength?: number;
  videoRelativeStartMs?: number;
  audioRelativeStartMs?: number;
}

export interface FastSegmentedClipMessage extends BaseMessage {
  type: MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP;
  payload: FastSegmentedClipPayload;
}

export interface FastSegmentedClipResponsePayload {
  downloadId: string;
  type: "success" | "error" | "progress";
  blobUrl?: string;
  warning?: string;
  error?: string;
  progress?: number;
  message?: string;
}

export type ExtensionMessage =
  | DownloadRequestMessage
  | DownloadProgressMessage
  | ClipRequestMessage
  | GetPlaybackCandidatesMessage
  | GetClipDraftMessage
  | SetClipMarkMessage
  | ClearClipDraftMessage
  | FastSegmentedClipMessage
  | BaseMessage;

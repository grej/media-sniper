import type { ClipRequest, ManifestQualitySelection } from "../core/clipping/types";
import type { DownloadState } from "../core/types";
import { MessageType } from "../shared/messages";

export interface HistoryRedownloadAction {
  message: {
    type: MessageType;
    payload: unknown;
  };
  queuedMessage: string;
}

function selectedQuality(state: DownloadState): ManifestQualitySelection | undefined {
  const operation = state.operation;
  if (!operation) return undefined;
  if (operation.manifestQuality) return { ...operation.manifestQuality };
  return operation.qualityKey ? { qualityKey: operation.qualityKey } : undefined;
}

/** Rebuild the original operation while retaining legacy full-download behavior. */
export function createHistoryRedownloadAction(
  state: DownloadState,
): HistoryRedownloadAction {
  const operation = state.operation;
  if (operation?.kind === "clip" && operation.clip) {
    const payload: ClipRequest = {
      url: state.url,
      format: state.metadata.format,
      clip: { ...operation.clip },
      metadata: { ...state.metadata },
      pageUrl: state.metadata.pageUrl,
      manifestQuality: selectedQuality(state),
      allowFullFetchForDirect: operation.allowFullFetchForDirect,
      outputContainer:
        operation.outputContainer === "mp4" ? "mp4" : undefined,
    };
    return {
      message: { type: MessageType.CLIP_REQUEST, payload },
      queuedMessage: "Clip queued",
    };
  }

  let website: string | undefined;
  try {
    website = new URL(state.metadata.pageUrl ?? state.url).hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    // The existing download path accepts an absent website hint.
  }

  const isLive = state.metadata.isLive === true;
  return {
    message: {
      type: isLive ? MessageType.START_RECORDING : MessageType.DOWNLOAD_REQUEST,
      payload: {
        url: state.url,
        metadata: state.metadata,
        tabTitle: state.metadata.title,
        website,
      },
    },
    queuedMessage: isLive ? "Recording started" : "Download queued",
  };
}

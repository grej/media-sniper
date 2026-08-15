import type { ClipRequest } from "./types";
import { VideoFormat } from "../types";

export type ClipHandlerKind = "direct" | "hls-segmented" | "dash-segmented";

/** Select the clipping pipeline independently of Fast versus Exact mode. */
export function selectClipHandlerKind(
  request: Pick<ClipRequest, "format" | "clip">,
): ClipHandlerKind | null {
  switch (request.format) {
    case VideoFormat.DIRECT:
      return "direct";
    case VideoFormat.HLS:
    case VideoFormat.M3U8:
      return "hls-segmented";
    case VideoFormat.DASH:
      return "dash-segmented";
    default:
      return null;
  }
}

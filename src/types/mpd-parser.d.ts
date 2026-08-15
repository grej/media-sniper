declare module "mpd-parser" {
  interface ParseOptions {
    manifestUri?: string;
    previousManifest?: unknown;
    sidxMapping?: Record<string, unknown>;
  }

  interface MpdSegment {
    uri: string;
    resolvedUri: string;
    duration: number;
    presentationTime?: number;
    timeline?: number;
    number?: number;
    discontinuity?: boolean;
    byterange?: { offset: number | bigint; length: number | bigint };
    map?: {
      uri: string;
      resolvedUri: string;
      byterange?: { offset: number | bigint; length: number | bigint };
    };
  }

  interface MpdPlaylist {
    uri: string;
    attributes: {
      BANDWIDTH?: number;
      RESOLUTION?: { width: number; height: number };
      CODECS?: string;
      NAME?: string;
      AUDIO?: string;
      contentProtection?: Record<string, unknown>;
      [key: string]: unknown;
    };
    segments?: MpdSegment[];
    contentProtection?: Record<string, unknown>;
    resolvedUri?: string;
    timeline?: number;
    timelineStarts?: Array<{ start: number; timeline: number }>;
    discontinuityStarts?: number[];
    mediaSequence?: number;
    discontinuitySequence?: number;
    sidx?: {
      uri: string;
      resolvedUri: string;
      byterange: { offset: number | bigint; length: number | bigint };
    };
  }

  interface MpdAudioGroup {
    language?: string;
    autoselect?: boolean;
    default?: boolean;
    playlists?: MpdPlaylist[];
  }

  interface MpdManifest {
    playlists: MpdPlaylist[];
    mediaGroups: {
      AUDIO?: {
        audio?: Record<string, MpdAudioGroup>;
      };
    };
    minimumUpdatePeriod?: number;
    duration?: number;
    endList?: boolean;
    timelineStarts?: Array<{ start: number; timeline: number }>;
    [key: string]: unknown;
  }

  function parse(manifestString: string, options?: ParseOptions): MpdManifest;

  export { parse, MpdSegment, MpdPlaylist, MpdManifest, MpdAudioGroup };
}

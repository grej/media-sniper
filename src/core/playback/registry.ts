import type { PlaybackCandidate, PlaybackRange } from './types';

export interface PlaybackRegistryOptions {
  document?: Document;
  window?: Window;
  createId?: () => string;
  IntersectionObserverCtor?: typeof IntersectionObserver;
  MutationObserverCtor?: typeof MutationObserver;
}

let fallbackId = 0;

function createPageVideoId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `page-video-${randomUuid}`;
  fallbackId += 1;
  return `page-video-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function normalizeSource(source: string): string {
  if (!source) return '';
  try {
    const url = new URL(source, globalThis.location?.href);
    url.hash = '';
    return url.href;
  } catch {
    return source.split('#', 1)[0];
  }
}

function toMilliseconds(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function readSeekableRanges(video: HTMLVideoElement): PlaybackRange[] {
  const ranges: PlaybackRange[] = [];
  try {
    for (let index = 0; index < video.seekable.length; index += 1) {
      ranges.push({
        startMs: toMilliseconds(video.seekable.start(index)),
        endMs: toMilliseconds(video.seekable.end(index)),
      });
    }
  } catch {
    // Media state can change between reading length and a range boundary.
  }
  return ranges;
}

/** Tracks video elements for the lifetime of a content-script frame. */
export class PlaybackRegistry {
  private readonly document: Document;
  private readonly window: Window;
  private readonly createId: () => string;
  private readonly intersectionObserverCtor?: typeof IntersectionObserver;
  private readonly mutationObserverCtor?: typeof MutationObserver;
  private readonly ids = new WeakMap<HTMLVideoElement, string>();
  private readonly videos = new Map<string, HTMLVideoElement>();
  private readonly intersectionRatios = new WeakMap<HTMLVideoElement, number>();
  private intersectionObserver?: IntersectionObserver;
  private mutationObserver?: MutationObserver;
  private started = false;

  constructor(options: PlaybackRegistryOptions = {}) {
    this.document = options.document ?? document;
    this.window = options.window ?? window;
    this.createId = options.createId ?? createPageVideoId;
    this.intersectionObserverCtor = options.IntersectionObserverCtor
      ?? globalThis.IntersectionObserver;
    this.mutationObserverCtor = options.MutationObserverCtor
      ?? globalThis.MutationObserver;
  }

  start(): void {
    if (this.started) {
      this.scan();
      return;
    }
    this.started = true;

    if (this.intersectionObserverCtor) {
      this.intersectionObserver = new this.intersectionObserverCtor((entries) => {
        for (const entry of entries) {
          if (this.isVideoElement(entry.target)) {
            this.intersectionRatios.set(entry.target, entry.intersectionRatio);
          }
        }
      });
    }

    this.scan();

    const root = this.document.documentElement;
    if (root && this.mutationObserverCtor) {
      this.mutationObserver = new this.mutationObserverCtor((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) this.registerNode(node);
        }
        this.prune();
      });
      this.mutationObserver.observe(root, { childList: true, subtree: true });
    }
  }

  scan(): void {
    this.document.querySelectorAll('video').forEach((video) => this.register(video));
    this.prune();
  }

  register(video: HTMLVideoElement): string {
    let id = this.ids.get(video);
    if (!id) {
      id = this.createId();
      this.ids.set(video, id);
    }
    if (!this.videos.has(id)) {
      this.videos.set(id, video);
      this.intersectionObserver?.observe(video);
    }
    return id;
  }

  prune(): void {
    for (const [id, video] of this.videos) {
      if (!video.isConnected || video.ownerDocument !== this.document) {
        this.intersectionObserver?.unobserve(video);
        this.videos.delete(id);
      }
    }
  }

  destroy(): void {
    this.mutationObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.videos.clear();
    this.started = false;
  }

  getCandidates(frameUrl = this.window.location.href): PlaybackCandidate[] {
    this.scan();
    return [...this.videos].map(([pageVideoId, video]) =>
      this.snapshot(pageVideoId, video, frameUrl));
  }

  getElement(pageVideoId: string): HTMLVideoElement | undefined {
    const video = this.videos.get(pageVideoId);
    return video?.isConnected ? video : undefined;
  }

  /** Finds the best local element association for detection metadata. */
  findPageVideoId(sourceUrl: string): string | undefined {
    this.scan();
    const normalized = normalizeSource(sourceUrl);
    const exact = [...this.videos].filter(([, video]) =>
      normalizeSource(video.currentSrc || video.src) === normalized);
    if (exact.length === 1) return exact[0][0];

    const active = [...this.videos].filter(([, video]) => !video.paused && !video.ended);
    if (active.length === 1) return active[0][0];
    if (this.videos.size === 1) return this.videos.keys().next().value;
    return undefined;
  }

  private registerNode(node: Node): void {
    if (this.isVideoElement(node)) this.register(node);
    if (node.nodeType === Node.ELEMENT_NODE) {
      (node as Element).querySelectorAll<HTMLVideoElement>('video')
        .forEach((video) => this.register(video));
    }
  }

  private isVideoElement(node: Node): node is HTMLVideoElement {
    return node.nodeType === Node.ELEMENT_NODE
      && (node as Element).tagName.toLowerCase() === 'video';
  }

  private snapshot(
    pageVideoId: string,
    video: HTMLVideoElement,
    frameUrl: string,
  ): PlaybackCandidate {
    const rect = video.getBoundingClientRect();
    const renderedArea = Math.max(0, rect.width) * Math.max(0, rect.height);
    const geometricRatio = this.geometricIntersectionRatio(rect, renderedArea);
    const observedRatio = this.intersectionRatios.get(video);
    const intersectionRatio = Math.max(0, Math.min(1, observedRatio ?? geometricRatio));
    const style = this.window.getComputedStyle(video);
    const visible = video.isConnected
      && renderedArea > 0
      && intersectionRatio > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0';
    const durationMs = Number.isFinite(video.duration) && video.duration >= 0
      ? Math.round(video.duration * 1000)
      : undefined;

    return {
      pageVideoId,
      frameUrl,
      currentSrc: video.currentSrc || video.src || '',
      currentTimeMs: toMilliseconds(video.currentTime),
      durationMs,
      paused: video.paused,
      ended: video.ended,
      readyState: video.readyState,
      visible,
      intersectionRatio,
      renderedArea: Math.round(renderedArea),
      muted: video.muted,
      volume: Number.isFinite(video.volume) ? video.volume : 1,
      playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
      seekableRanges: readSeekableRanges(video),
    };
  }

  private geometricIntersectionRatio(rect: DOMRect, renderedArea: number): number {
    if (renderedArea <= 0) return 0;
    const width = Math.max(0, Math.min(rect.right, this.window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, this.window.innerHeight) - Math.max(rect.top, 0));
    return (width * height) / renderedArea;
  }
}

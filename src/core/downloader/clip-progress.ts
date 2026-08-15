import type { DownloadProgress, DownloadState } from "../types";
import { DownloadStage } from "../types";
import { storeDownload } from "../database/downloads";

export interface ClipProgressUpdate {
  stage: DownloadStage;
  percentage?: number;
  message?: string;
  downloaded?: number;
  total?: number;
}

export interface ClipProgressTrackerOptions {
  state: DownloadState;
  syncIntervalMs: number;
  store?: typeof storeDownload;
  notify?: (state: DownloadState) => void;
  now?: () => number;
}

/** Cached durable progress: no IndexedDB read is performed on the hot path. */
export class ClipProgressTracker {
  readonly state: DownloadState;
  private readonly syncIntervalMs: number;
  private readonly store: typeof storeDownload;
  private readonly notify?: (state: DownloadState) => void;
  private readonly now: () => number;
  private lastSyncAt = 0;
  private pendingSync: Promise<void> = Promise.resolve();

  constructor(options: ClipProgressTrackerOptions) {
    this.state = options.state;
    this.syncIntervalMs = options.syncIntervalMs;
    this.store = options.store ?? storeDownload;
    this.notify = options.notify;
    this.now = options.now ?? Date.now;
  }

  update(update: ClipProgressUpdate): void {
    const stageChanged = update.stage !== this.state.progress.stage;
    const timestamp = this.now();
    const progress: DownloadProgress = {
      ...this.state.progress,
      stage: update.stage,
      ...(update.percentage !== undefined ? { percentage: update.percentage } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
      ...(update.downloaded !== undefined ? { downloaded: update.downloaded } : {}),
      ...(update.total !== undefined ? { total: update.total } : {}),
      lastUpdateTime: timestamp,
    };
    this.state.progress = progress;
    this.state.updatedAt = timestamp;
    this.notify?.(this.state);

    if (stageChanged || timestamp - this.lastSyncAt >= this.syncIntervalMs) {
      this.queueSync(timestamp);
    }
  }

  async flush(): Promise<void> {
    this.queueSync(this.now());
    await this.pendingSync;
  }

  private queueSync(timestamp: number): void {
    this.lastSyncAt = timestamp;
    this.pendingSync = this.pendingSync
      .catch(() => undefined)
      .then(() => this.store(this.state));
  }
}

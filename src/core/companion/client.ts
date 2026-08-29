import {
  createCompanionEnvelope,
  validateCompanionRequest,
  validateCompanionEvent,
  type CompanionEnvelope,
  type CompanionEvent,
} from "./protocol";
import {
  COMPANION_HOST_NAME,
  type CompanionErrorCode,
  type CompanionFailure,
  type CompanionHealth,
} from "./types";

export class CompanionClientError extends Error {
  constructor(
    readonly code: CompanionErrorCode,
    message: string,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = "CompanionClientError";
  }
}

type PendingRequest = {
  resolve: (event: CompanionEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventListener = (event: CompanionEvent) => void;

export interface NativePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

const RESPONSE_TYPES = new Set([
  "hello_result",
  "probe_result",
  "auth_required",
  "job_queued",
  "fallback_required",
  "job_completed",
  "job_failed",
  "job_cancelled",
]);

export class CompanionClient {
  private port: NativePortLike | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<EventListener>();
  private requestCounter = 0;

  constructor(
    private readonly connectPort: () => NativePortLike = () =>
      chrome.runtime.connectNative(COMPANION_HOST_NAME),
  ) {}

  get connected(): boolean {
    return this.port !== null;
  }

  connect(): void {
    if (this.port) return;
    let port: NativePortLike;
    try {
      port = this.connectPort();
    } catch {
      throw new CompanionClientError(
        "COMPANION_NOT_INSTALLED",
        "Media Sniper Companion is not connected.",
      );
    }
    this.port = port;
    port.onMessage.addListener((message) => this.handleMessage(message));
    port.onDisconnect.addListener(() => this.handleDisconnect());
  }

  disconnect(): void {
    const port = this.port;
    this.port = null;
    port?.disconnect();
    this.rejectAll(new CompanionClientError("JOB_INTERRUPTED", "Companion disconnected."));
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async hello(browserTarget: CompanionHealth["browserTarget"]): Promise<CompanionHealth> {
    const event = await this.request("hello", {
      browserTarget,
      extensionVersion: chrome.runtime.getManifest().version,
    });
    if (event.type !== "hello_result") throw this.failureFromEvent(event);
    return event.payload as CompanionHealth;
  }

  async request<T extends Record<string, unknown>>(
    type: string,
    payload: T,
    timeoutMs = 30_000,
  ): Promise<CompanionEvent> {
    const requestId = `${Date.now().toString(36)}-${(++this.requestCounter).toString(36)}-${crypto.randomUUID()}`;
    const envelope = createCompanionEnvelope(type, requestId, payload);
    if (!validateCompanionRequest(envelope)) {
      throw new CompanionClientError("INVALID_REQUEST", "The companion request was invalid.", false);
    }
    this.connect();

    return await new Promise<CompanionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CompanionClientError("JOB_INTERRUPTED", "The companion did not respond in time."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.port!.postMessage(envelope);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          new CompanionClientError(
            "COMPANION_NOT_INSTALLED",
            error instanceof Error ? error.message : "Companion is unavailable.",
          ),
        );
      }
    });
  }

  post<T extends Record<string, unknown>>(type: string, payload: T): string {
    const requestId = `${Date.now().toString(36)}-${(++this.requestCounter).toString(36)}-${crypto.randomUUID()}`;
    const envelope = createCompanionEnvelope(type, requestId, payload);
    if (!validateCompanionRequest(envelope)) {
      throw new CompanionClientError("INVALID_REQUEST", "The companion request was invalid.", false);
    }
    this.connect();
    this.port!.postMessage(envelope);
    return requestId;
  }

  private handleMessage(message: unknown): void {
    if (!validateCompanionEvent(message)) {
      const port = this.port;
      this.port = null;
      this.rejectAll(
        new CompanionClientError("PROTOCOL_MISMATCH", "The companion sent an invalid protocol message."),
      );
      port?.disconnect();
      return;
    }
    const event = message as CompanionEvent;
    for (const listener of this.listeners) listener(event);

    const pending = this.pending.get(event.requestId);
    if (!pending || !RESPONSE_TYPES.has(event.type)) return;
    clearTimeout(pending.timer);
    this.pending.delete(event.requestId);
    if (event.type === "job_failed" || event.type === "auth_required") {
      pending.reject(this.failureFromEvent(event));
    } else {
      pending.resolve(event);
    }
  }

  private failureFromEvent(event: CompanionEnvelope): CompanionClientError {
    const failure = event.payload as CompanionFailure;
    return new CompanionClientError(
      failure.code ?? "INTERNAL_ERROR",
      failure.message ?? "The companion could not complete the request.",
      failure.recoverable ?? true,
    );
  }

  private handleDisconnect(error?: Error): void {
    this.port = null;
    const runtimeError = chrome.runtime.lastError?.message;
    this.rejectAll(
      error ??
        new CompanionClientError(
          runtimeError ? "COMPANION_NOT_INSTALLED" : "JOB_INTERRUPTED",
          runtimeError ? "Media Sniper Companion is not connected." : "The companion connection closed.",
        ),
    );
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

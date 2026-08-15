import type { DownloadState } from "../types";

export interface ActiveOperation<T = unknown> {
  id: string;
  operationKey: string;
  value: T;
}

/**
 * Runtime identity is operation-ID based while exact duplicates are detected
 * by their deterministic operation key.
 */
export class ActiveOperationRegistry<T = unknown> {
  private readonly byId = new Map<string, ActiveOperation<T>>();
  private readonly idByOperationKey = new Map<string, string>();

  get size(): number {
    return this.byId.size;
  }

  register(operation: ActiveOperation<T>): boolean {
    if (
      this.byId.has(operation.id) ||
      this.idByOperationKey.has(operation.operationKey)
    ) {
      return false;
    }
    this.byId.set(operation.id, operation);
    this.idByOperationKey.set(operation.operationKey, operation.id);
    return true;
  }

  getById(id: string): ActiveOperation<T> | undefined {
    return this.byId.get(id);
  }

  getByOperationKey(operationKey: string): ActiveOperation<T> | undefined {
    const id = this.idByOperationKey.get(operationKey);
    return id ? this.byId.get(id) : undefined;
  }

  values(): ActiveOperation<T>[] {
    return [...this.byId.values()];
  }

  removeById(id: string): ActiveOperation<T> | undefined {
    const operation = this.byId.get(id);
    if (!operation) return undefined;
    this.byId.delete(id);
    this.idByOperationKey.delete(operation.operationKey);
    return operation;
  }

  clear(): void {
    this.byId.clear();
    this.idByOperationKey.clear();
  }

  rebuild(
    states: DownloadState[],
    valueForState: (state: DownloadState) => T,
  ): void {
    this.clear();
    for (const state of states) {
      if (!state.operation) continue;
      this.register({
        id: state.id,
        operationKey: state.operation.operationKey,
        value: valueForState(state),
      });
    }
  }
}

export class SerialEventQueue<T> {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly handle: (event: T) => void | Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  push(event: T): void {
    this.tail = this.tail
      .then(() => this.handle(event))
      .catch((error) => this.onError(error));
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}

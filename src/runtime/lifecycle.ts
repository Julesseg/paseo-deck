export interface LifecycleResources {
  releaseObservations(): Promise<unknown>;
  closeGateway(): Promise<unknown>;
  drainInput(): Promise<unknown>;
  restoreTerminal(): Promise<unknown>;
}

export class ShutdownCoordinator {
  readonly #resources: LifecycleResources;
  #shutdown: Promise<void> | undefined;

  constructor(resources: LifecycleResources) {
    this.#resources = resources;
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= this.#run();
    return this.#shutdown;
  }

  async #run(): Promise<void> {
    const errors: unknown[] = [];
    const steps = [
      this.#resources.releaseObservations,
      this.#resources.closeGateway,
      this.#resources.drainInput,
      this.#resources.restoreTerminal,
    ];

    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Paseo Deck cleanup failed");
    }
  }
}

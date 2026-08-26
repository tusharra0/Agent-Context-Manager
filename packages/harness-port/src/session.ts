import {
  HarnessEventDataV1Schema,
  HarnessEventV1Schema,
  HarnessTurnInputV1Schema,
  type AgentHarnessSession,
  type HarnessEventDataV1,
  type HarnessEventFactoryOptions,
  type HarnessEventV1,
  type HarnessSessionDriver,
  type HarnessTurnInputV1,
} from './contracts.js';

export class HarnessSessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessSessionStateError';
  }
}

interface ActiveTurn {
  controller: AbortController;
  started: boolean;
  reason?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'The harness turn failed with an unknown error.';
}

export class ManagedAgentHarnessSession implements AgentHarnessSession {
  readonly id;
  readonly harness;
  readonly startedEvent: HarnessEventV1;

  private sequence = 0;
  private activeTurn: ActiveTurn | undefined;
  private destroyedEvent: HarnessEventV1 | undefined;
  private readonly now;

  constructor(
    private readonly driver: HarnessSessionDriver,
    options: HarnessEventFactoryOptions,
  ) {
    this.id = options.sessionId;
    this.harness = options.harness;
    this.now = options.now ?? (() => new Date());
    this.startedEvent = this.envelope({
      kind: 'session-started',
      vendorSessionId: driver.vendorSessionId,
    });
  }

  stream(input: HarnessTurnInputV1): AsyncIterable<HarnessEventV1> {
    if (this.destroyedEvent !== undefined) {
      throw new HarnessSessionStateError('The harness session is destroyed.');
    }
    if (this.activeTurn !== undefined) {
      throw new HarnessSessionStateError(
        'Only one turn may run in a harness session at a time.',
      );
    }

    const parsedInput = HarnessTurnInputV1Schema.parse(input);
    const controller = new AbortController();
    const activeTurn: ActiveTurn = {
      controller,
      started: false,
    };
    this.activeTurn = activeTurn;
    return this.runTurn(parsedInput, activeTurn);
  }

  async interrupt(reason?: string): Promise<void> {
    if (this.destroyedEvent !== undefined) return;
    const activeTurn = this.activeTurn;
    if (activeTurn === undefined || activeTurn.controller.signal.aborted)
      return;
    if (reason !== undefined) activeTurn.reason = reason;
    activeTurn.controller.abort(reason);
    if (!activeTurn.started) {
      if (this.activeTurn === activeTurn) this.activeTurn = undefined;
    }
  }

  async destroy(): Promise<HarnessEventV1> {
    if (this.destroyedEvent !== undefined) return this.destroyedEvent;

    const activeTurn = this.activeTurn;
    if (activeTurn !== undefined) {
      activeTurn.reason = 'session-destroyed';
      activeTurn.controller.abort(activeTurn.reason);
      if (!activeTurn.started) {
        this.activeTurn = undefined;
      }
    }

    await this.driver.destroy();
    this.destroyedEvent = this.envelope({ kind: 'session-destroyed' });
    return this.destroyedEvent;
  }

  private async *runTurn(
    input: HarnessTurnInputV1,
    activeTurn: ActiveTurn,
  ): AsyncGenerator<HarnessEventV1> {
    let emittedTerminalEvent = false;
    activeTurn.started = true;
    try {
      if (this.activeTurn !== activeTurn) {
        const reason = activeTurn.reason;
        yield this.envelope(
          reason === undefined
            ? { kind: 'interrupted' }
            : { kind: 'interrupted', reason },
        );
        return;
      }
      for await (const unparsedEvent of this.driver.streamTurn(
        input,
        activeTurn.controller.signal,
      )) {
        const event = HarnessEventDataV1Schema.parse(unparsedEvent);
        if (
          event.kind === 'turn-completed' ||
          event.kind === 'interrupted' ||
          event.kind === 'error'
        ) {
          emittedTerminalEvent = true;
        }
        yield this.envelope(event);
      }

      if (activeTurn.controller.signal.aborted && !emittedTerminalEvent) {
        const interrupted: HarnessEventDataV1 =
          activeTurn.reason === undefined
            ? { kind: 'interrupted' }
            : { kind: 'interrupted', reason: activeTurn.reason };
        yield this.envelope(interrupted);
      } else if (!emittedTerminalEvent) {
        yield this.envelope({
          kind: 'diagnostic',
          code: 'turn-ended-without-terminal-event',
          message: 'The harness stream ended without a terminal event.',
        });
      }
    } catch (error) {
      yield this.envelope({ kind: 'error', message: errorMessage(error) });
    } finally {
      if (this.activeTurn === activeTurn) this.activeTurn = undefined;
    }
  }

  private envelope(data: HarnessEventDataV1): HarnessEventV1 {
    this.sequence += 1;
    return HarnessEventV1Schema.parse({
      schemaVersion: 1,
      sessionId: this.id,
      harness: this.harness,
      sequence: this.sequence,
      createdAt: this.now().toISOString(),
      ...data,
    });
  }
}

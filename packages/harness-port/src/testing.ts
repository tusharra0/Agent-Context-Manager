import {
  CreateHarnessSessionInputV1Schema,
  type AgentHarnessPort,
  type AgentHarnessSession,
  type CreateHarnessSessionInputV1,
  type HarnessEventDataV1,
  type HarnessKind,
  type HarnessSessionDriver,
  type HarnessTurnInputV1,
} from './contracts.js';
import { ManagedAgentHarnessSession } from './session.js';

export interface ScriptedHarnessTurn {
  events: readonly HarnessEventDataV1[];
  waitForAbort?: boolean;
  error?: Error;
}

export interface ScriptedHarnessPortOptions {
  harness: HarnessKind;
  turns: readonly ScriptedHarnessTurn[];
  now?: () => Date;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

class ScriptedDriver implements HarnessSessionDriver {
  readonly vendorSessionId;
  destroyed = false;
  private turnIndex = 0;

  constructor(
    sessionId: string,
    private readonly turns: readonly ScriptedHarnessTurn[],
  ) {
    this.vendorSessionId = `scripted:${sessionId}`;
  }

  async *streamTurn(
    _input: HarnessTurnInputV1,
    signal: AbortSignal,
  ): AsyncGenerator<HarnessEventDataV1> {
    const turn = this.turns[this.turnIndex];
    this.turnIndex += 1;
    if (turn === undefined) {
      throw new Error('No scripted turn remains for this session.');
    }

    for (const event of turn.events) {
      if (signal.aborted) return;
      yield event;
    }
    if (turn.waitForAbort === true) await waitForAbort(signal);
    if (turn.error !== undefined) throw turn.error;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export class ScriptedHarnessPort implements AgentHarnessPort {
  readonly harness;
  readonly createdSessions: AgentHarnessSession[] = [];

  constructor(private readonly options: ScriptedHarnessPortOptions) {
    this.harness = options.harness;
  }

  async createSession(
    input: CreateHarnessSessionInputV1,
  ): Promise<AgentHarnessSession> {
    const parsedInput = CreateHarnessSessionInputV1Schema.parse(input);
    const driver = new ScriptedDriver(
      parsedInput.sessionId,
      this.options.turns,
    );
    const session = new ManagedAgentHarnessSession(driver, {
      sessionId: parsedInput.sessionId,
      harness: this.harness,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
    this.createdSessions.push(session);
    return session;
  }
}

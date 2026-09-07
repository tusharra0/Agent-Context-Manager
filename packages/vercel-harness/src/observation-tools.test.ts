import type { Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@acm/core';
import type {
  HarnessToolInvocation,
  InterceptedObservation,
  ObservationInterceptor,
  ObservationMode,
  RawToolOutput,
} from '@acm/harness-port';

import { createObservationSandboxConfig } from './adapter.js';
import {
  ObservationToolSandboxUnavailableError,
  ObservationToolSession,
  buildRipgrepCommand,
  combineCommandStreams,
  createObservationTools,
  type ObservationToolSandbox,
} from './observation-tools.js';

type ExecuteOptions = Parameters<NonNullable<Tool['execute']>>[1];

type Captured = {
  invocation: HarnessToolInvocation;
  output: RawToolOutput;
};

class FakeInterceptor implements ObservationInterceptor {
  readonly policy = 'reduced' as const;
  readonly captured: Captured[] = [];

  constructor(
    private readonly mode: ObservationMode = 'raw',
    private readonly text?: string,
  ) {}

  async intercept(
    invocation: HarnessToolInvocation,
    output: RawToolOutput,
  ): Promise<InterceptedObservation> {
    this.captured.push({ invocation, output });
    const text = this.text ?? Buffer.from(output.bytes).toString('utf8');
    return {
      text,
      isError: output.isError,
      record: {
        schemaVersion: 1,
        toolCallId: invocation.toolCallId,
        toolName: invocation.toolName,
        policy: 'reduced',
        mode: this.mode,
        reductionOutcome: this.mode === 'reduced' ? 'applied' : 'no-reducer',
        rawByteLength: output.bytes.byteLength,
        rawTokenEstimate: 1,
        observedTokenEstimate: 1,
        tokenEstimatorId: 'utf8-bytes-div-4@1',
        diagnostics: [],
      },
    };
  }
}

function fakeSandbox(
  overrides: Partial<ObservationToolSandbox> = {},
): ObservationToolSandbox {
  return {
    readBinaryFile: vi.fn(async () => new Uint8Array()),
    readTextFile: vi.fn(async () => ''),
    run: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    ...overrides,
  };
}

function attached(sandbox: ObservationToolSandbox): ObservationToolSession {
  const session = new ObservationToolSession();
  session.attach(sandbox, '/workspace/repo');
  return session;
}

function toolsFor(
  interceptor: ObservationInterceptor,
  session: ObservationToolSession,
) {
  return createObservationTools({ interceptor, target: session.resolve });
}

async function call(
  tool: Tool | undefined,
  input: JsonValue,
  toolCallId = 'call-1',
): Promise<unknown> {
  const execute = tool?.execute;
  if (execute === undefined) throw new Error('The tool has no execute.');
  return execute(input, {
    toolCallId,
    messages: [],
  } as unknown as ExecuteOptions);
}

describe('read override', () => {
  it('reads whole files as bytes and forwards them unchanged', async () => {
    const content = 'export const value = 1;\n';
    const readBinaryFile = vi.fn(
      async () => new Uint8Array(Buffer.from(content, 'utf8')),
    );
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(
      interceptor,
      attached(fakeSandbox({ readBinaryFile })),
    );

    const result = await call(tools.read, { file_path: 'src/index.ts' });

    expect(readBinaryFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/index.ts' }),
    );
    expect(result).toBe(content);
    expect(interceptor.captured[0]?.invocation).toEqual({
      toolCallId: 'call-1',
      toolName: 'read',
      input: { file_path: 'src/index.ts' },
    });
    expect(Buffer.from(interceptor.captured[0]!.output.bytes).toString()).toBe(
      content,
    );
  });

  it('turns an offset and limit into an inclusive line range', async () => {
    const readTextFile = vi.fn(async () => 'line five\n');
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(
      interceptor,
      attached(fakeSandbox({ readTextFile })),
    );

    await call(tools.read, { file_path: 'src/index.ts', offset: 5, limit: 10 });

    expect(readTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 5, endLine: 14 }),
    );
  });

  it('leaves an open-ended range without an end line', async () => {
    const readTextFile = vi.fn(async () => 'tail\n');
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(
      interceptor,
      attached(fakeSandbox({ readTextFile })),
    );

    await call(tools.read, { file_path: 'src/index.ts', offset: 5 });

    const options = readTextFile.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.startLine).toBe(5);
    expect(options).not.toHaveProperty('endLine');
  });

  it('reports a missing file without recording it as evidence', async () => {
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(
      interceptor,
      attached(fakeSandbox({ readBinaryFile: vi.fn(async () => null) })),
    );

    const result = await call(tools.read, { file_path: 'src/missing.ts' });

    expect(result).toBe('[acm: no such file: src/missing.ts]');
    expect(interceptor.captured).toHaveLength(0);
  });

  it('omits absent optional arguments from the recorded input', async () => {
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(interceptor, attached(fakeSandbox()));

    await call(tools.read, { file_path: 'src/index.ts', offset: undefined });

    expect(interceptor.captured[0]?.invocation.input).toEqual({
      file_path: 'src/index.ts',
    });
  });
});

describe('grep override', () => {
  it('builds a parseable ripgrep command and quotes its arguments', () => {
    expect(
      buildRipgrepCommand({ pattern: 'value', path: 'src', glob: '*.ts' }),
    ).toBe("rg --json --no-config -g '*.ts' -e 'value' -- 'src'");
    expect(
      buildRipgrepCommand({ pattern: "it's", caseInsensitive: true }),
    ).toBe("rg --json --no-config -i -e 'it'\\''s' -- '.'");
  });

  it('treats no matches as a result rather than a failure', async () => {
    const run = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' }));
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(interceptor, attached(fakeSandbox({ run })));

    await call(tools.grep, { pattern: 'missing' });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/workspace/repo' }),
    );
    expect(interceptor.captured[0]?.output).toMatchObject({
      isError: false,
      exitCode: 1,
    });
  });

  it('surfaces a real search failure with its diagnostics', async () => {
    const run = vi.fn(async () => ({
      exitCode: 2,
      stdout: '',
      stderr: 'rg: command not found',
    }));
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(interceptor, attached(fakeSandbox({ run })));

    await call(tools.grep, { pattern: 'value' });

    const captured = interceptor.captured[0]!;
    expect(captured.output.isError).toBe(true);
    expect(Buffer.from(captured.output.bytes).toString()).toContain(
      'rg: command not found',
    );
  });

  it('records the command it actually ran', async () => {
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(interceptor, attached(fakeSandbox()));

    await call(tools.grep, { pattern: 'value' });

    expect(interceptor.captured[0]?.invocation.input).toMatchObject({
      pattern: 'value',
      command: "rg --json --no-config -e 'value' -- '.'",
    });
  });
});

describe('bash override', () => {
  it('keeps stdout alone so a JSON reporter stays reducible', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"testResults":[]}',
      stderr: '',
    }));
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(interceptor, attached(fakeSandbox({ run })));

    await call(tools.bash, { command: 'pnpm vitest run --reporter=json' });

    expect(Buffer.from(interceptor.captured[0]!.output.bytes).toString()).toBe(
      '{"testResults":[]}',
    );
  });

  it('combines streams once a command writes to stderr', () => {
    expect(combineCommandStreams('out', '')).toBe('out');
    expect(combineCommandStreams('out', 'warn')).toBe('out\n[stderr]\nwarn');
  });

  it('annotates a failing command only when no reduction carries the code', async () => {
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: 'boom',
      stderr: '',
    }));
    const rawTools = toolsFor(
      new FakeInterceptor('raw'),
      attached(fakeSandbox({ run })),
    );
    expect(await call(rawTools.bash, { command: 'false' })).toBe(
      'boom\n[acm: command exited 1]',
    );

    const reducedTools = toolsFor(
      new FakeInterceptor('reduced', '{"exitCode":1}'),
      attached(fakeSandbox({ run })),
    );
    expect(await call(reducedTools.bash, { command: 'false' })).toBe(
      '{"exitCode":1}',
    );
  });

  it('forwards the exit code and error flag to the interceptor', async () => {
    const run = vi.fn(async () => ({ exitCode: 3, stdout: 'x', stderr: '' }));
    const interceptor = new FakeInterceptor();
    const tools = toolsFor(interceptor, attached(fakeSandbox({ run })));

    await call(tools.bash, { command: 'pnpm build' });

    expect(interceptor.captured[0]?.output).toMatchObject({
      isError: true,
      exitCode: 3,
    });
  });
});

describe('createObservationTools', () => {
  it('overrides every supported builtin by default', () => {
    const tools = toolsFor(new FakeInterceptor(), attached(fakeSandbox()));
    expect(Object.keys(tools).sort()).toEqual(['bash', 'grep', 'read']);
  });

  it('overrides only the requested builtins', () => {
    const tools = createObservationTools({
      interceptor: new FakeInterceptor(),
      target: attached(fakeSandbox()).resolve,
      tools: ['bash', 'bash'],
    });
    expect(Object.keys(tools)).toEqual(['bash']);
  });

  it('refuses an empty override set that would silently do nothing', () => {
    expect(() =>
      createObservationTools({
        interceptor: new FakeInterceptor(),
        target: attached(fakeSandbox()).resolve,
        tools: [],
      }),
    ).toThrow(TypeError);
  });

  it('fails loudly when no sandbox session is attached', async () => {
    const session = new ObservationToolSession();
    const tools = toolsFor(new FakeInterceptor(), session);

    await expect(call(tools.read, { file_path: 'a.ts' })).rejects.toThrow(
      ObservationToolSandboxUnavailableError,
    );
  });

  it('stops resolving a target once the session is detached', async () => {
    const session = attached(fakeSandbox());
    const tools = toolsFor(new FakeInterceptor(), session);
    session.detach();

    await expect(call(tools.bash, { command: 'ls' })).rejects.toThrow(
      ObservationToolSandboxUnavailableError,
    );
  });

  it('requires a working directory when attaching a session', () => {
    expect(() =>
      new ObservationToolSession().attach(fakeSandbox(), ''),
    ).toThrow(TypeError);
  });
});

describe('createObservationSandboxConfig', () => {
  it('attaches the live session and still runs a caller hook', async () => {
    const session = new ObservationToolSession();
    const onSession = vi.fn(async () => undefined);
    const config = createObservationSandboxConfig(
      { workDir: 'repo', onSession },
      session,
    );
    const sandbox = fakeSandbox();

    await config.onSession!({
      session: sandbox as never,
      sessionWorkDir: '/vercel/sandbox/repo',
    });

    expect(session.current).toEqual({
      session: sandbox,
      workingDirectory: '/vercel/sandbox/repo',
    });
    expect(onSession).toHaveBeenCalledOnce();
    expect(config.workDir).toBe('repo');
  });

  it('works without any caller-supplied configuration', async () => {
    const session = new ObservationToolSession();
    const config = createObservationSandboxConfig(undefined, session);

    await config.onSession!({
      session: fakeSandbox() as never,
      sessionWorkDir: '/vercel/sandbox/harness-1',
    });

    expect(session.current?.workingDirectory).toBe('/vercel/sandbox/harness-1');
  });
});

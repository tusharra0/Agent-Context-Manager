export type CliIo = {
  stdout(message: string): void;
  stderr(message: string): void;
};

export type CliRuntime = {
  environment: NodeJS.ProcessEnv;
  now(): Date;
};

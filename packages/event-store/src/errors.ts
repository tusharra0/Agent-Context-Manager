export class ArtifactUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactUriError';
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}

export class DestinationExistsError extends Error {
  constructor(outputPath: string) {
    super(`Refusing to overwrite existing destination: ${outputPath}`);
    this.name = 'DestinationExistsError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session does not exist: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

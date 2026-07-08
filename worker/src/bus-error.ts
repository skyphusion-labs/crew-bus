/** Client-safe validation errors. Only BusError messages may be returned to callers. */
export class BusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusError";
  }
}

export function clientErrorMessage(err: unknown): string | null {
  return err instanceof BusError ? err.message : null;
}

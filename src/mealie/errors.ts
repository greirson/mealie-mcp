export type MealieErrorKind = 'http' | 'timeout' | 'network';

export interface MealieErrorInit {
  kind: MealieErrorKind;
  status: number;
  method: string;
  path: string;
  detail?: unknown;
}

export class MealieError extends Error {
  readonly kind: MealieErrorKind;
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly detail?: unknown;

  constructor(init: MealieErrorInit) {
    super(`Mealie ${init.kind} error ${init.status} for ${init.method} ${init.path}`);
    this.name = 'MealieError';
    this.kind = init.kind;
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.detail = init.detail;
  }
}

/** Raised by tools for problems with the caller's input; its message is shown verbatim. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function toToolMessage(err: unknown, notFoundHint?: string): string {
  if (err instanceof ToolInputError) return err.message;
  if (!(err instanceof MealieError)) {
    return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const where = `${err.method} ${err.path}`;
  if (err.kind === 'timeout') return `Mealie did not respond within the timeout for ${where}. Try again shortly.`;
  if (err.kind === 'network') return `Mealie is unreachable from the MCP server (${where}). Check that the Mealie container is running.`;
  switch (err.status) {
    case 401:
      return 'Mealie rejected this connection\'s API token (it was deleted or expired). Reconnect the Mealie connector in Claude to sign in again.';
    case 403:
      return `Your Mealie account does not have permission for ${where}.`;
    case 404:
      return `Not found in Mealie: ${where}.${notFoundHint ? ` ${notFoundHint}` : ''}`;
    case 422:
      return `Mealie rejected the request as invalid (${where}): ${describe(err.detail)}`;
    default:
      if (err.status >= 500) return `Mealie returned HTTP ${err.status} for ${where}. Try again shortly.`;
      return `Mealie returned HTTP ${err.status} for ${where}: ${describe(err.detail)}`;
  }
}

function describe(detail: unknown): string {
  if (detail === undefined || detail === null || detail === '') return 'no details';
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

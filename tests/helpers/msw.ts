import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const mswServer = setupServer();

beforeAll(() =>
  mswServer.listen({
    onUnhandledRequest(request, print) {
      const host = new URL(request.url).hostname;
      // Requests to the app under test go to a real local listener.
      if (host === '127.0.0.1' || host === 'localhost') return;
      print.error();
    },
  })
);
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

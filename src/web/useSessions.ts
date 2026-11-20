import { useEffect, useState } from 'react';

import { type SessionDetail, SessionListSchema, SessionStateSchema } from '../shared/schema';

/**
 * Estado ao vivo das simulações via SSE. `sessions` chega na conexão e quando
 * uma simulação começa/termina; `tick` chega a cada posição enviada.
 */
export function useSessions(): { sessions: Map<string, SessionDetail>; connected: boolean } {
  const [sessions, setSessions] = useState(() => new Map<string, SessionDetail>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/events');

    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));

    source.addEventListener('sessions', (event: MessageEvent) => {
      const parsed = SessionListSchema.safeParse(parseData(event.data));
      if (!parsed.success) return;
      setSessions(new Map(parsed.data.sessions.map((s) => [s.deviceId, s])));
    });

    source.addEventListener('tick', (event: MessageEvent) => {
      const parsed = SessionStateSchema.safeParse(parseData(event.data));
      if (!parsed.success) return;
      const state = parsed.data;
      setSessions((current) => {
        const existing = current.get(state.deviceId);
        if (!existing) return current;
        const next = new Map(current);
        next.set(state.deviceId, { ...existing, ...state });
        return next;
      });
    });

    return () => source.close();
  }, []);

  return { sessions, connected };
}

function parseData(data: unknown): unknown {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    return value;
  } catch {
    return null;
  }
}

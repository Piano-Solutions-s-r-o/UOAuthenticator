import { useEffect, useRef } from 'react';

import { getJson, type QueryValue } from '../utils/api.js';

export type RegistrationState = {
  status: 'pending' | 'verified' | 'authorized' | 'complete' | 'expired';
  token?: string;
  token_type?: string;
};

export function useRegistrationStatus(params: {
  id: string | undefined;
  query: Record<string, QueryValue>;
  onState: (state: RegistrationState) => void;
}) {
  const callback = useRef(params.onState);
  useEffect(() => { callback.current = params.onState; }, [params.onState]);
  useEffect(() => {
    if (!params.id) return;
    let stopped = false;
    let checking = false;
    let recheck = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const query = { ...params.query, id: params.id };
    // Retain a low-frequency safety check even on a connected socket. This
    // covers dropped events and provides a fallback on proxies blocking WSS.
    const poll = setInterval(() => { void check(); }, 10000);
    // A terminal state never changes again (24 h validity could otherwise mean a day of 10 s
    // polling and reconnects): stop the timers and the socket, and never reconnect.
    function stop() {
      stopped = true;
      clearInterval(poll); clearTimeout(retry);
      socket?.close();
    }
    async function check() {
      if (stopped) return;
      if (checking) { recheck = true; return; }
      checking = true;
      const response = await getJson<RegistrationState>('/auth/registration/status', query);
      checking = false;
      if (!stopped && response.ok) {
        callback.current(response.data);
        if (response.data.status === 'expired' || response.data.status === 'complete') stop();
      } else if (!stopped && !response.ok && [400, 401, 403].includes(response.status)) {
        callback.current({ status: 'expired' });
        stop();
      }
      if (recheck && !stopped) { recheck = false; void check(); }
    }
    function connect() {
      if (stopped || typeof WebSocket === 'undefined') return;
      const url = new URL('/auth/registration/events', window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      for (const [key, value] of Object.entries(query)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      try { socket = new WebSocket(url); }
      catch { scheduleReconnect(); return; }
      socket.onopen = () => { delay = 1000; void check(); };
      socket.onmessage = () => { void check(); }; // A hint only; never trust event authority.
      socket.onclose = scheduleReconnect;
      socket.onerror = () => { socket?.close(); };
    }
    function scheduleReconnect() {
      if (stopped) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    }
    void check();
    connect();
    const focus = () => { if (document.visibilityState !== 'hidden') void check(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      stop();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [params.id, params.query]);
}

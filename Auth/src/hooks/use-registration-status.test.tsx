// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../utils/api.js', () => ({ getJson: mocks.get }));
import { useRegistrationStatus } from './use-registration-status.js';

beforeEach(() => { mocks.get.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('rechecks an event arriving while an older pending-state request is in flight', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let resolveInitial: (value: unknown) => void = () => {};
  mocks.get.mockReturnValueOnce(new Promise(resolve => { resolveInitial = resolve; }))
    .mockResolvedValue({ ok: true, data: { status: 'complete' } });
  class Socket {
    static current: Socket;
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { Socket.current = this; }
    close() { this.onclose?.(); }
  }
  vi.stubGlobal('WebSocket', Socket);
  const received = vi.fn();
  const query = { config_url: 'https://product.example/config' };
  function Harness() {
    useRegistrationStatus({ id: 'pending-registration', query, onState: received });
    return null;
  }
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => {
      Socket.current.onmessage?.();
      resolveInitial({ ok: true, data: { status: 'pending' } });
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(received).toHaveBeenLastCalledWith({ status: 'complete' });
  } finally { act(() => root.unmount()); host.remove(); }
});

// A terminal state never changes again, so a registration valid for 24 h must not keep polling
// every 10 s or reconnecting its socket for a day after the server said it is over.
it.each(['expired', 'complete'] as const)('stops polling and reconnecting after a %s response', async (terminal) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.get.mockResolvedValue({ ok: true, data: { status: terminal } });
  let sockets = 0;
  class Socket {
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor() { sockets += 1; }
    close() { this.closed = true; this.onclose?.(); }
  }
  vi.stubGlobal('WebSocket', Socket);
  const received = vi.fn();
  const query = { config_url: 'https://product.example/config' };
  function Harness() {
    useRegistrationStatus({ id: 'pending-registration', query, onState: received });
    return null;
  }
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    expect(received).toHaveBeenCalledExactlyOnceWith({ status: terminal });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(sockets).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000); });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(sockets).toBe(1);
    expect(received).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { act(() => root.unmount()); host.remove(); }
});

it('keeps polling while the registration is still pending', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.get.mockResolvedValue({ ok: true, data: { status: 'pending' } });
  vi.stubGlobal('WebSocket', undefined);
  function Harness() {
    useRegistrationStatus({ id: 'pending-registration', query: { config_url: 'https://product.example/config' }, onState: () => {} });
    return null;
  }
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.get).toHaveBeenCalledTimes(4); // the first check, then one every 10 s
  } finally { act(() => root.unmount()); host.remove(); }
});

// HUGO-2261: the status route verifies the product's config on every poll, so a short product
// outage answers 400. A registration is still valid then and must survive it.
it.each([
  ['a failed config fetch', { ok: false, status: 400, error: 'Request failed', code: null }],
  ['a rate limit', { ok: false, status: 429, error: 'Request failed', code: null }],
  ['a server error', { ok: false, status: 502, error: 'Request failed', code: null }],
  ['no network', { ok: false, status: 0, error: null, code: null }],
])('keeps waiting through %s and still picks up the authorization', async (_name, failure) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.get.mockResolvedValueOnce(failure)
    .mockResolvedValue({ ok: true, data: { status: 'authorized', token: 'token', token_type: 'VERIFY_EMAIL_SET_PASSWORD' } });
  vi.stubGlobal('WebSocket', undefined);
  const received = vi.fn();
  function Harness() {
    useRegistrationStatus({ id: 'pending-registration', query: { config_url: 'https://product.example/config' }, onState: received });
    return null;
  }
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    expect(received).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(received).toHaveBeenCalledExactlyOnceWith({ status: 'authorized', token: 'token', token_type: 'VERIFY_EMAIL_SET_PASSWORD' });
  } finally { act(() => root.unmount()); host.remove(); }
});

it('stops on the final refusal and shows the registration as over', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.get.mockResolvedValue({ ok: false, status: 400, error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' });
  vi.stubGlobal('WebSocket', undefined);
  const received = vi.fn();
  function Harness() {
    useRegistrationStatus({ id: 'pending-registration', query: { config_url: 'https://product.example/config' }, onState: received });
    return null;
  }
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(received).toHaveBeenCalledExactlyOnceWith({ status: 'expired' });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { act(() => root.unmount()); host.remove(); }
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getJson, postBinary, postJson, setRequestLanguage } from './api.js';

describe('api Accept-Language header', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { origin: 'https://auth.example' } });
  });

  afterEach(() => {
    setRequestLanguage(null);
    vi.unstubAllGlobals();
  });

  function sentHeaders(): Record<string, string> {
    return (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
  }

  it('sends no Accept-Language until a language is set', async () => {
    await getJson('/x');
    expect(sentHeaders()['accept-language']).toBeUndefined();
  });

  it('sends the current language on JSON requests', async () => {
    setRequestLanguage('cs');
    await postJson('/x', { a: 1 });
    expect(sentHeaders()['accept-language']).toBe('cs');
  });

  it('follows changes and can be cleared', async () => {
    setRequestLanguage('cs');
    setRequestLanguage('en');
    await getJson('/x');
    expect(sentHeaders()['accept-language']).toBe('en');
    fetchMock.mockClear();
    setRequestLanguage(null);
    await getJson('/x');
    expect(sentHeaders()['accept-language']).toBeUndefined();
  });

  it('sends the current language on binary requests', async () => {
    setRequestLanguage('cs');
    await postBinary('/x', {});
    expect(sentHeaders()['accept-language']).toBe('cs');
  });
});

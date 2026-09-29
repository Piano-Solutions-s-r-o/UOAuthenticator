import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getJson, setRequestLanguage } from '../utils/api.js';
import { I18nProvider } from './I18nProvider.js';

// HUGO-1815: the provider is what keeps the API informed of the shown language; without that call
// the emails silently fall back to the browser language, so the wiring itself is pinned here.
describe('I18nProvider → API request language', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { origin: 'https://auth.example' } });
  });

  afterEach(() => {
    setRequestLanguage(null);
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  async function headerAfterRender(initialSearch: string): Promise<string | undefined> {
    renderToString(
      <I18nProvider config={{ language_config: ['en', 'cs'] }} configUrl="" initialSearch={initialSearch}>
        <div />
      </I18nProvider>,
    );
    await getJson('/x');
    return (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers[
      'accept-language'
    ];
  }

  it('sends the ui_locales language the page renders in', async () => {
    expect(await headerAfterRender('?ui_locales=cs')).toBe('cs');
  });

  it('sends the first configured language without ui_locales', async () => {
    expect(await headerAfterRender('')).toBe('en');
  });
});

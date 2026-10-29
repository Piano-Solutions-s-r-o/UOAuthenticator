import { describe, expect, it } from 'vitest';
import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
const payload = () => ({ ...baseClientConfigPayload(), redirect_urls: ['https://app.example.com/auth/callback'] });
describe('signed login restart config', () => {
  it('preserves an allowed initiation URI', () => {
    expect(validateConfigFields({ ...payload(), login_restart_url: 'https://app.example.com/login?start=1' }).login_restart_url).toBe('https://app.example.com/login?start=1');
  });
  it.each(['https://other.example.com/login', 'http://app.example.com/login', 'javascript:alert(1)', 'https://user:pass@app.example.com/login', 'https://app.example.com/login#token', 'https://app.example.com:8443/login'])('rejects unsafe restart %s', (url) => {
    expect(() => validateConfigFields({ ...payload(), login_restart_url: url })).toThrow();
  });
  // Custom-scheme redirects and javascript:/data: URLs all have the opaque origin "null".
  it.each(['javascript:alert(1)', 'data:text/html,x', 'com.acme.app://login'])('rejects restart %s beside a custom-scheme redirect', (url) => {
    expect(() => validateConfigFields({ ...payload(), redirect_urls: ['com.acme.app://cb'], login_restart_url: url })).toThrow();
  });
  it('trims the claim like a redirect URL', () => {
    expect(validateConfigFields({ ...payload(), login_restart_url: ' https://app.example.com/login?start=1 ' }).login_restart_url).toBe('https://app.example.com/login?start=1');
  });
  it('supports local isolated development', () => {
    expect(validateConfigFields({ ...payload(), redirect_urls: ['http://localhost:4174/auth/callback'], login_restart_url: 'http://localhost:4174/login?start=1' }).login_restart_url).toBe('http://localhost:4174/login?start=1');
  });
  it('retains existing clients without the optional claim', () => {
    expect(validateConfigFields(payload()).login_restart_url).toBeUndefined();
  });
});

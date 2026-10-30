function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The server's word that this browser may finish a registration: the address only, never a token. */
export type RegistrationHandoff = { email: string };

function toRegistrationHandoff(value: unknown): RegistrationHandoff | null {
  return isRecord(value) && typeof value.email === 'string' ? { email: value.email } : null;
}

type ClientBootstrap = { config: unknown; configUrl: string; registrationHandoff: RegistrationHandoff | null };

function readWindowBootstrap(): ClientBootstrap {
  if (typeof window === 'undefined') return { config: {}, configUrl: '', registrationHandoff: null };

  const w = window as unknown as {
    __UOA_CLIENT_CONFIG__?: unknown;
    __UOA_CONFIG_URL__?: unknown;
    __UOA_REGISTRATION_HANDOFF__?: unknown;
  };

  const config = w.__UOA_CLIENT_CONFIG__ ?? {};
  const configUrl = typeof w.__UOA_CONFIG_URL__ === 'string' ? w.__UOA_CONFIG_URL__ : '';
  return { config, configUrl, registrationHandoff: toRegistrationHandoff(w.__UOA_REGISTRATION_HANDOFF__) };
}

export function readClientBootstrap(params?: {
  serverConfig?: unknown;
  serverConfigUrl?: string;
  serverRegistrationHandoff?: unknown;
}): ClientBootstrap {
  // SSR render passes config explicitly; client render reads from window bootstrap injected by API.
  if (params?.serverConfig !== undefined) {
    return {
      config: isRecord(params.serverConfig) ? params.serverConfig : {},
      configUrl: typeof params.serverConfigUrl === 'string' ? params.serverConfigUrl : '',
      registrationHandoff: toRegistrationHandoff(params.serverRegistrationHandoff),
    };
  }

  return readWindowBootstrap();
}


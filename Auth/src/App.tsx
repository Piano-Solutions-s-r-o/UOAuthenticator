import { PopupContainer } from './components/layout/PopupContainer.js';
import { I18nProvider } from './i18n/I18nProvider.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { readClientBootstrap } from './utils/bootstrap.js';

export function App(props?: {
  config?: unknown;
  configUrl?: string;
  initialSearch?: string;
  registrationHandoff?: unknown;
}) {
  const bootstrap = readClientBootstrap({
    serverConfig: props?.config,
    serverConfigUrl: props?.configUrl,
    serverRegistrationHandoff: props?.registrationHandoff,
  });

  return (
    <ThemeProvider config={bootstrap.config} configUrl={bootstrap.configUrl}>
      <I18nProvider
        config={bootstrap.config}
        configUrl={bootstrap.configUrl}
        initialSearch={props?.initialSearch}
      >
        <PopupContainer
          configUrl={bootstrap.configUrl}
          config={bootstrap.config}
          initialSearch={props?.initialSearch}
          registrationHandoff={bootstrap.registrationHandoff}
        />
      </I18nProvider>
    </ThemeProvider>
  );
}

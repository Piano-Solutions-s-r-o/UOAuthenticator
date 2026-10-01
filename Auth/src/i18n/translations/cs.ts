import type { Translations } from './en.js';

export const cs = {
  'auth.login.title': 'Přihlášení',
  'auth.register.title': 'Vytvoření účtu',
  'auth.resetPassword.title': 'Obnovení hesla',
  'auth.setPassword.title': 'Nastavení hesla',
  'auth.accessRequested.title': 'Žádost o přístup byla odeslána',
  'auth.signedIn.title': 'Přihlášení je hotové',
  'auth.twoFactorVerify.title': 'Ověření dvoufaktorovým kódem',
  'auth.twoFactorSetup.title': 'Nastavení dvoufaktorového ověření',
  'auth.codeEntry.title': 'Zadej svůj kód',
  'auth.workspaceChooser.title': 'Vyber pracovní prostor',
  'auth.signatures.title': 'Zkontroluj a podepiš dohody',

  'form.email.label': 'E-mail',
  'form.password.label': 'Heslo',
  'form.newPassword.label': 'Nové heslo',
  'form.confirmPassword.label': 'Potvrzení hesla',

  'form.rememberMe.label': 'Zapamatovat si mě',
  'form.password.show': 'Zobrazit',
  'form.password.hide': 'Skrýt',
  'form.password.requirement.minLength': 'Alespoň 8 znaků',
  'form.error.generic': 'Požadavek se nezdařil. Zkus to prosím znovu.',
  'form.login.submit': 'Přihlásit se',
  'form.login.error': 'Neplatný e-mail nebo heslo.',
  'form.register.submit': 'Registrovat',
  'form.resetPassword.submit': 'Odeslat pokyny k obnovení',
  'form.setPassword.submit': 'Nastavit heslo a pokračovat',
  'form.setPassword.error': 'Něco se nepodařilo. Zkus to prosím znovu.',
  'form.setPassword.tooShort': 'Heslo musí mít alespoň 8 znaků.',
  'form.setPassword.linkInvalid':
    'Tento odkaz je neplatný nebo jeho platnost vypršela. Vyžádej si nový a zkus to znovu.',
  'form.setPassword.mismatch': 'Hesla se neshodují.',
  'form.setPassword.success': 'Heslo bylo úspěšně obnoveno. Nyní se můžeš přihlásit.',

  'message.instructionsSent': 'Poslali jsme ti pokyny na e-mail',
  'message.emailAlreadyRegistered':
    'Tento e-mail už je zaregistrovaný. Pokračuj prosím přihlášením nebo obnovením hesla.',
  'message.accessRequested':
    'Tvoje žádost byla odeslána správcům týmu. Toto okno můžeš zavřít a počkat na schválení.',
  'message.signedIn': 'Vrať se do aplikace a dokonči přihlášení. Toto okno můžeš zavřít.',
  'action.openApp': 'Otevřít aplikaci',

  'nav.forgotPassword': 'Zapomenuté heslo?',
  'nav.createAccount': 'Vytvořit účet',
  'nav.backToLogin': 'Zpět na přihlášení',
  'nav.resetPassword': 'Obnovit heslo',
  'nav.emailMeCode': 'Poslat mi přihlašovací kód e-mailem',

  'codeEntry.instructions': 'Poslali jsme kód na {email}',
  'codeEntry.submit': 'Ověřit',
  'codeEntry.resend': 'Poslat kód znovu',
  'codeEntry.resend.sent': 'Poslali jsme nový kód na tvůj e-mail',
  'codeEntry.error': 'Kód se nepodařilo ověřit. Zkus to prosím znovu.',

  'workspaceChooser.subtitle': 'Tvoje pracovní prostory pro {email}',
  'workspaceChooser.autoSkip': 'Přihlašování…',
  'workspace.role.owner': 'Vlastník',
  'workspace.role.admin': 'Správce',
  'workspace.invite.title': 'Máš pozvánku do {teamName}',
  'workspace.invite.invitedBy': 'Pozval(a) {invitedBy}',
  'workspace.invite.accept': 'Přijmout',
  'workspace.invite.decline': 'Odmítnout',
  'workspace.createOrg.title': 'Vytvořit nový pracovní prostor',
  'workspace.createOrg.subtitle': 'Začni zcela nový pracovní prostor',

  'twoFactor.setup.instructions':
    'Naskenuj tento QR kód v ověřovací aplikaci a potom zadej 6místný kód pro dokončení nastavení.',
  'twoFactor.setup.loading': 'Načítá se QR kód...',
  'twoFactor.setup.manual': 'Klíč pro ruční nastavení:',
  'twoFactor.setup.error': 'Dvoufaktorové ověření se nepodařilo nastavit. Zkus to prosím znovu.',
  'twoFactor.setup.submit': 'Zapnout 2FA',
  'twoFactor.setup.success': 'Dvoufaktorové ověření je zapnuté',
  'twoFactor.qr.alt': 'QR kód pro nastavení dvoufaktorového ověření',
  'twoFactor.qr.placeholder': 'QR kód se zobrazí zde',
  'twoFactor.code.label': 'Ověřovací kód',

  'twoFactor.verify.instructions':
    'Zadej 6místný kód z ověřovací aplikace a dokonči přihlášení.',
  'twoFactor.verify.error': 'Kód se nepodařilo ověřit. Zkus to prosím znovu.',
  'twoFactor.verify.submit': 'Ověřit',
  'twoFactor.verify.success': 'Ověření bylo úspěšné',

  'social.divider': 'nebo',
  'social.continueWith': 'Pokračovat přes',

  'signatures.loading': 'Načítají se tvoje dohody…',
  'signatures.restart':
    'Tato podpisová relace již není dostupná. Vrať se do aplikace a zahaj přihlášení znovu.',
  'signatures.intro':
    'Doména {domain} vyžaduje před dokončením přihlášení následující aktuální dohody.',
  'signatures.expires': 'Platnost této zabezpečené podpisové relace skončí v {time}.',
  'signatures.sourceError': 'Ověřený zdrojový dokument se nepodařilo načíst. Zkus to znovu.',
  'signatures.receiptError': 'Ověřené potvrzení se nepodařilo stáhnout. Zkus to znovu.',
  'signatures.signError': 'Dohodu se nepodařilo podepsat. Zkontroluj potvrzení a zkus to znovu.',
  'signatures.signed': 'Dohoda byla podepsána. Potvrzení o ověřeném důkazu je připraveno níže.',
  'signatures.version': 'Verze {version}',
  'signatures.downloadSource': 'Stáhnout zdrojové PDF',
  'signatures.loadingDocument': 'Načítá se ověřené PDF…',
  'signatures.viewerTitle': 'Prohlížeč PDF pro {title}',
  'signatures.confirmTitle': 'Prohlášení o přijetí',
  'signatures.confirmCheckbox': 'Výslovně potvrzuji výše uvedené prohlášení o přijetí.',
  'signatures.fullName': 'Tvoje celé jméno',
  'signatures.nameAssertion':
    'Zadané jméno se zaznamená jako tvoje tvrzení. Nejde o nezávislé ověření totožnosti.',
  'signatures.evidenceNotice':
    'UOA zaznamenává ověřený důkaz o dohodě a ověřuje jeho integritu. Nejde o notářské ověření, kvalifikovaný elektronický podpis ani právní poradenství.',
  'signatures.signing': 'Podepisování…',
  'signatures.signContinue': 'Podepsat a pokračovat',
  'signatures.completeTitle': 'Všechny aktuální dohody jsou podepsány',
  'signatures.completeBody':
    'Stáhni si potřebná potvrzení a dokonči přihlášení. Před vydáním přístupu se požadavky ještě jednou zkontrolují.',
  'signatures.receiptsTitle': 'Potvrzení o důkazu',
  'signatures.verificationReference': 'Ověřovací reference',
  'signatures.revoked': 'Tento podpis byl odvolán.',
  'signatures.downloading': 'Stahování…',
  'signatures.downloadReceipt': 'Stáhnout potvrzení',
  'signatures.finishing': 'Dokončování…',
  'signatures.finish': 'Dokončit přihlášení',
} satisfies Translations;

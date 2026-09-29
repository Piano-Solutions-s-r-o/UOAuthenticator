export type Density = 'compact' | 'comfortable' | 'spacious';

export type ButtonStyle = 'solid' | 'outline' | 'ghost';
export type ButtonFontWeight = 'medium' | 'semibold' | 'bold';
export type PageLayout = 'default' | 'centered';
export type CardStyle = 'plain' | 'bordered' | 'shadow';

export type FontFamilyPreset = 'sans' | 'serif' | 'mono';
export type FontFamily = FontFamilyPreset | (string & {});
export type BaseTextSize = 'sm' | 'md' | 'lg';

export type ThemeVars = Record<string, string>;

export type Theme = {
  vars: ThemeVars;
  layout: PageLayout;
  density: Density;
  typography: {
    fontFamily: FontFamily;
    baseTextSize: BaseTextSize;
    fontImportUrl?: string;
  };
  button: {
    style: ButtonStyle;
    fontWeight: ButtonFontWeight;
  };
  card: {
    style: CardStyle;
  };
  logo: {
    url: string;
    alt: string;
    text?: string;
    fontSize?: string;
    color?: string;
    style?: Record<string, string>;
  };
};

export type ThemeClassNames = {
  appShell: string;
  pageContainer: string;
  card: string;
  logoWrap: string;
  logoImage: string;
  languageSelectorWrap: string;
  title: string;
  buttonPrimary: string;
  buttonSecondary: string;
};


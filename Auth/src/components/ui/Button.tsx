import React from 'react';

import { useTheme } from '../../hooks/use-theme.js';

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'secondaryFilled';
  },
): React.JSX.Element {
  const { classNames } = useTheme();
  const { variant = 'primary', className, ...rest } = props;

  const themed =
    variant === 'secondary'
      ? classNames.buttonSecondary
      : variant === 'secondaryFilled'
        ? classNames.buttonSecondaryFilled
        : classNames.buttonPrimary;
  const merged = className ? `${themed} ${className}` : themed;

  return <button {...rest} className={merged} />;
}


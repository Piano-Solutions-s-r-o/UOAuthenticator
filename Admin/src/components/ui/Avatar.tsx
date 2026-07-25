import { useEffect, useState } from 'react';

type AvatarProps = {
  label: string;
  shape?: 'round' | 'square';
  size?: 'sm' | 'md';
  /** Image URL (typically an object URL). Falls back to initials when absent or unloadable. */
  src?: string | null;
};

export function Avatar({ label, shape = 'round', size = 'sm', src = null }: AvatarProps) {
  const [isBroken, setIsBroken] = useState(false);
  const sizeClass = size === 'md' ? 'h-12 w-12 text-lg' : 'h-8 w-8 text-xs';
  const shapeClass = shape === 'square' ? 'rounded-xl' : 'rounded-full';

  useEffect(() => {
    setIsBroken(false);
  }, [src]);

  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden ${sizeClass} ${shapeClass} bg-indigo-100 font-semibold text-indigo-700`}>
      {src && !isBroken ? (
        // Decorative: every avatar surface renders the name or email next to it.
        <img alt="" className="h-full w-full object-cover" src={src} onError={() => setIsBroken(true)} />
      ) : (
        avatarInitials(label)
      )}
    </span>
  );
}

/** Up to two uppercase initials; tolerates empty, padded, and multi-space labels. */
export function avatarInitials(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
}

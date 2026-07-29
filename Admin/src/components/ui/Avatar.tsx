import { useEffect, useRef, useState } from 'react';

type AvatarProps = {
  label: string;
  shape?: 'round' | 'square';
  size?: 'sm' | 'md';
  /** Image URL (typically an object URL). Falls back to initials when absent or unloadable. */
  src?: string | null;
};

type ImageStatus = 'pending' | 'loaded' | 'broken';

/**
 * Initials show until the image has genuinely painted. A blocked image (for example a
 * `blob:` URL rejected by CSP) can be dropped without ever firing `onError`, so gating on
 * `onLoad` rather than only on failure is what keeps a blocked avatar from rendering as an
 * empty circle. `onError` is still terminal: it falls back to initials permanently.
 */
export function Avatar({ label, shape = 'round', size = 'sm', src = null }: AvatarProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<ImageStatus>('pending');
  const sizeClass = size === 'md' ? 'h-12 w-12 text-lg' : 'h-8 w-8 text-xs';
  const shapeClass = shape === 'square' ? 'rounded-xl' : 'rounded-full';

  useEffect(() => {
    // A cached image can finish decoding before React attaches `onLoad`; `complete` with a
    // real intrinsic width catches that so the avatar is not stuck on initials forever.
    const image = imageRef.current;
    setStatus(image?.complete && image.naturalWidth > 0 ? 'loaded' : 'pending');
  }, [src]);

  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden ${sizeClass} ${shapeClass} bg-indigo-100 font-semibold text-indigo-700`}>
      {src && status !== 'broken' ? (
        // Decorative: every avatar surface renders the name or email next to it.
        <img
          ref={imageRef}
          alt=""
          className={`h-full w-full object-cover ${status === 'loaded' ? '' : 'hidden'}`}
          src={src}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('broken')}
        />
      ) : null}
      {status === 'loaded' ? null : avatarInitials(label)}
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

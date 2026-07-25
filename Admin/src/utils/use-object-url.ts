import { useEffect, useState } from 'react';

/**
 * Renders blob bytes through a temporary object URL and revokes it when the blob changes or the
 * component unmounts. Avatar images must be fetched by the admin API client (the endpoints need
 * the admin bearer, which `<img src>` cannot send), so the bytes arrive as a Blob, not a URL.
 */
export function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }

    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  return url;
}

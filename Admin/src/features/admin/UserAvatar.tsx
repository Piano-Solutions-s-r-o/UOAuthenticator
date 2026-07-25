import { useEffect, useState } from 'react';

import { Avatar } from '../../components/ui/Avatar';
import { useUserAvatarQuery } from './admin-queries';

type UserAvatarProps = {
  userId: string;
  label: string;
  size?: 'sm' | 'md';
};

/**
 * Image-backed avatar for a known user id. The admin avatar endpoint needs the admin
 * bearer, which `<img src>` cannot send, so the bytes are fetched as a blob and rendered
 * from an object URL. Loading and failure both fall back to the initials avatar.
 */
export function UserAvatar({ label, size = 'sm', userId }: UserAvatarProps) {
  const avatarQuery = useUserAvatarQuery(userId);
  const src = useObjectUrl(avatarQuery.data);

  return <Avatar label={label} size={size} src={src} />;
}

function useObjectUrl(blob: Blob | undefined) {
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

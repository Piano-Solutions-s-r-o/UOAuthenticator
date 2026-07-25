import { Avatar } from '../../components/ui/Avatar';
import { useObjectUrl } from '../../utils/use-object-url';
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

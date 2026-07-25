import { Avatar } from '../../components/ui/Avatar';
import { useObjectUrl } from '../../utils/use-object-url';
import { useTeamAvatarQuery } from './admin-queries';

type TeamAvatarProps = {
  teamId: string;
  label: string;
  size?: 'sm' | 'md';
};

/**
 * Image-backed square avatar for a known team ("company"). Same transport constraint as
 * `UserAvatar`: the admin avatar endpoint needs the admin bearer, which `<img src>` cannot send,
 * so the bytes are fetched as a blob and rendered from an object URL. Loading and failure both
 * fall back to the initials avatar.
 */
export function TeamAvatar({ label, size = 'sm', teamId }: TeamAvatarProps) {
  const avatarQuery = useTeamAvatarQuery(teamId);
  const src = useObjectUrl(avatarQuery.data);

  return <Avatar label={label} shape="square" size={size} src={src} />;
}

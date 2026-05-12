import { ResourceType, PermissionTypes, Permissions } from 'librechat-data-provider';
import { useHasAccess } from '~/hooks';

const resourceToPermissionMap: Partial<Record<ResourceType, PermissionTypes>> = {
  [ResourceType.AGENT]: PermissionTypes.AGENTS,
  [ResourceType.PROMPTGROUP]: PermissionTypes.PROMPTS,
  [ResourceType.MCPSERVER]: PermissionTypes.MCP_SERVERS,
  [ResourceType.REMOTE_AGENT]: PermissionTypes.REMOTE_AGENTS,
  [ResourceType.SKILL]: PermissionTypes.SKILLS,
  [ResourceType.SHARED_LINK]: PermissionTypes.SHARED_LINKS,
};

export const useCanSharePublic = (resourceType: ResourceType): boolean => {
  const permissionType = resourceToPermissionMap[resourceType];

  const hasAccess = useHasAccess({
    permissionType: permissionType as PermissionTypes,
    permission: Permissions.SHARE_PUBLIC,
  });
  return hasAccess;
};

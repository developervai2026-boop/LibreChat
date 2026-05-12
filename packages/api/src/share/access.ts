import mongoose from 'mongoose';
import {
  PrincipalType,
  ResourceType,
  AccessRoleIds,
  PermissionBits,
} from 'librechat-data-provider';
import { tenantStorage, logger } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Types, Model } from 'mongoose';
import type { IUser, IAclEntry } from '@librechat/data-schemas';
import { AccessControlService } from '~/acl/accessControlService';
import { isEnabled } from '~/utils';

interface RawSharedLink {
  _id?: Types.ObjectId;
  conversationId: string;
  title?: string;
  user?: string;
  shareId?: string;
  tenantId?: string;
  isPublic?: boolean;
}

let _aclService: AccessControlService | null = null;
function getAclService(): AccessControlService {
  if (!_aclService) {
    _aclService = new AccessControlService(mongoose);
  }
  return _aclService;
}

function isAutoMigrateEnabled(): boolean {
  const val = process.env.SHARED_LINKS_AUTO_MIGRATE;
  return val === undefined || isEnabled(val);
}

async function autoMigrateLegacyLink(share: RawSharedLink): Promise<void> {
  const shareId = share._id;
  if (!shareId) {
    return;
  }

  const resourceId = shareId.toString();
  let ownerGranted = false;
  let publicGranted = false;

  if (share.user) {
    const existingOwner = await getAclService().checkPermission({
      userId: share.user,
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      requiredPermission: PermissionBits.DELETE,
    });

    if (!existingOwner) {
      try {
        await getAclService().grantPermission({
          principalType: PrincipalType.USER,
          principalId: share.user,
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
          accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
          grantedBy: share.user,
        });
        ownerGranted = true;
      } catch (err) {
        logger.error('[autoMigrateLegacyLink] Failed to grant OWNER', {
          shareId: share.shareId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (share.isPublic !== false && share.user) {
    const hasPublic = await hasPublicViewPermission(resourceId);

    if (!hasPublic) {
      try {
        await getAclService().grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
          accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
          grantedBy: share.user,
        });
        publicGranted = true;
      } catch (err) {
        logger.error('[autoMigrateLegacyLink] Failed to grant PUBLIC VIEWER', {
          shareId: share.shareId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (ownerGranted || publicGranted) {
    logger.info('[autoMigrateLegacyLink] Migrated legacy shared link', {
      shareId: share.shareId,
      resourceId,
      ownerGranted,
      publicGranted,
    });
  }
}

async function hasPublicViewPermission(resourceId: string): Promise<boolean> {
  const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  const entry = await AclEntry.findOne({
    principalType: PrincipalType.PUBLIC,
    resourceType: ResourceType.SHARED_LINK,
    resourceId,
  }).lean();
  return entry != null;
}

export async function resolveShareAccess(req: Request, res: Response): Promise<void> {
  const { shareId } = req.params;
  if (!shareId) {
    res.status(400).json({ message: 'Missing shareId' });
    return;
  }

  const SharedLink = mongoose.models.SharedLink as Model<RawSharedLink>;
  const rawShare = (await SharedLink.findOne({ shareId }).lean()) as RawSharedLink | null;

  if (!rawShare) {
    res.status(404).json({ message: 'Shared link not found' });
    return;
  }

  const resourceId = rawShare._id?.toString();
  if (!resourceId) {
    res.status(404).json({ message: 'Shared link not found' });
    return;
  }

  const user = req.user as IUser | undefined;

  const runWithTenant = async (fn: () => Promise<void>): Promise<void> => {
    if (rawShare.tenantId) {
      return tenantStorage.run({ tenantId: rawShare.tenantId }, fn);
    }
    return fn();
  };

  await runWithTenant(async () => {
    const isLegacy = 'isPublic' in rawShare;

    if (isLegacy) {
      if (!isAutoMigrateEnabled()) {
        res.status(403).json({ message: 'Legacy shared link requires migration' });
        return;
      }
      await autoMigrateLegacyLink(rawShare);
    }

    const publicGranted = await hasPublicViewPermission(resourceId);

    if (publicGranted) {
      if (isEnabled(process.env.ALLOW_SHARED_LINKS_PUBLIC)) {
        (req as unknown as Record<string, unknown>).shareResourceId = resourceId;
        return;
      }

      if (!user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }

      (req as unknown as Record<string, unknown>).shareResourceId = resourceId;
      return;
    }

    if (!user) {
      res.status(401).json({ message: 'Authentication required' });
      return;
    }

    const userId = user.id ?? user._id?.toString();
    if (!userId) {
      res.status(401).json({ message: 'Authentication required' });
      return;
    }

    const hasAccess = await getAclService().checkPermission({
      userId,
      role: user.role,
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      requiredPermission: PermissionBits.VIEW,
    });

    if (!hasAccess) {
      res.status(403).json({ message: 'You do not have permission to view this shared link' });
      return;
    }

    (req as unknown as Record<string, unknown>).shareResourceId = resourceId;
  });
}

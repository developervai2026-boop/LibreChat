jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import mongoose, { Types, Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { PrincipalType, AccessRoleIds } from 'librechat-data-provider';
import type { IAclEntry, ISharedLink } from '@librechat/data-schemas';
import {
  grantCreationPermissions,
  ensureOwnerPermission,
  deleteSharedLinkWithCleanup,
  deleteConvoSharedLinksWithCleanup,
  deleteAllSharedLinksWithCleanup,
} from './service';

let mongoServer: MongoMemoryServer;
let AclEntry: Model<IAclEntry>;
let SharedLink: Model<ISharedLink>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  const methods = createMethods(mongoose);
  await methods.seedDefaultRoles();
  AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  SharedLink = mongoose.models.SharedLink as Model<ISharedLink>;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AclEntry.deleteMany({});
  await SharedLink.deleteMany({});
});

const userId = new Types.ObjectId().toString();

async function createTestLink(overrides: Partial<ISharedLink> = {}) {
  return SharedLink.create({
    shareId: `share-${Date.now()}-${Math.random()}`,
    conversationId: 'convo1',
    user: userId,
    messages: [],
    ...overrides,
  });
}

describe('grantCreationPermissions', () => {
  test('creates OWNER and PUBLIC VIEWER AclEntries', async () => {
    const link = await createTestLink();
    await grantCreationPermissions(link._id, userId, true);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(2);

    const owner = entries.find((e) => e.principalType === PrincipalType.USER);
    expect(owner).toBeDefined();
    expect(owner!.principalId!.toString()).toBe(userId);

    const pub = entries.find((e) => e.principalType === PrincipalType.PUBLIC);
    expect(pub).toBeDefined();
  });

  test('creates only OWNER when grantPublic is false', async () => {
    const link = await createTestLink();
    await grantCreationPermissions(link._id, userId, false);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].principalType).toBe(PrincipalType.USER);
  });

  test('deletes SharedLink when OWNER grant fails', async () => {
    const link = await createTestLink();
    const badRoleId = 'nonexistent_role' as AccessRoleIds;

    const original = AccessRoleIds.SHARED_LINK_OWNER;
    try {
      // Temporarily break the role to force failure — use a non-existent user ID format
      // Instead, we delete the owner role to trigger the failure path
      const AccessRole = mongoose.models.AccessRole;
      await AccessRole.deleteOne({ accessRoleId: AccessRoleIds.SHARED_LINK_OWNER });

      await expect(grantCreationPermissions(link._id, userId, true)).rejects.toThrow();

      const linkAfter = await SharedLink.findById(link._id);
      expect(linkAfter).toBeNull();
    } finally {
      // Re-seed roles for subsequent tests
      const methods = createMethods(mongoose);
      await methods.seedDefaultRoles();
    }
  });
});

describe('ensureOwnerPermission', () => {
  test('creates OWNER AclEntry for legacy link with no entries', async () => {
    const link = await createTestLink();

    const beforeCount = await AclEntry.countDocuments({ resourceId: link._id });
    expect(beforeCount).toBe(0);

    await ensureOwnerPermission(link._id, userId);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].principalType).toBe(PrincipalType.USER);
  });

  test('is idempotent — does not duplicate on repeated calls', async () => {
    const link = await createTestLink();

    await ensureOwnerPermission(link._id, userId);
    await ensureOwnerPermission(link._id, userId);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(1);
  });

  test('does not delete the SharedLink on failure', async () => {
    const link = await createTestLink();
    const AccessRole = mongoose.models.AccessRole;
    await AccessRole.deleteOne({ accessRoleId: AccessRoleIds.SHARED_LINK_OWNER });

    try {
      await ensureOwnerPermission(link._id, userId);

      const linkAfter = await SharedLink.findById(link._id);
      expect(linkAfter).not.toBeNull();
    } finally {
      const methods = createMethods(mongoose);
      await methods.seedDefaultRoles();
    }
  });
});

describe('deleteSharedLinkWithCleanup', () => {
  test('deletes link and triggers ACL cleanup', async () => {
    const link = await createTestLink();
    await grantCreationPermissions(link._id, userId, true);

    const result = await deleteSharedLinkWithCleanup(userId, link.shareId!);

    expect(result).toMatchObject({ success: true, shareId: link.shareId! });
    expect(result!._id).toBe(link._id.toString());

    const linkAfter = await SharedLink.findById(link._id);
    expect(linkAfter).toBeNull();

    // ACL cleanup is async (fire-and-forget), wait briefly
    await new Promise((r) => setTimeout(r, 100));
    const aclAfter = await AclEntry.find({ resourceId: link._id }).lean();
    expect(aclAfter).toHaveLength(0);
  });

  test('returns null when link not found', async () => {
    const result = await deleteSharedLinkWithCleanup(userId, 'nonexistent');
    expect(result).toBeNull();
  });
});

describe('deleteConvoSharedLinksWithCleanup', () => {
  test('deletes all links for conversation and cleans up ACLs', async () => {
    const link1 = await createTestLink({ conversationId: 'convo-a' });
    const link2 = await createTestLink({ conversationId: 'convo-a' });
    await grantCreationPermissions(link1._id, userId, true);
    await grantCreationPermissions(link2._id, userId, false);

    const result = await deleteConvoSharedLinksWithCleanup(userId, 'convo-a');

    expect(result.deletedCount).toBe(2);

    await new Promise((r) => setTimeout(r, 100));
    const aclAfter = await AclEntry.find({
      resourceId: { $in: [link1._id, link2._id] },
    }).lean();
    expect(aclAfter).toHaveLength(0);
  });
});

describe('deleteAllSharedLinksWithCleanup', () => {
  test('deletes all user links and cleans up ACLs', async () => {
    const link1 = await createTestLink({ conversationId: 'c1' });
    const link2 = await createTestLink({ conversationId: 'c2' });
    await grantCreationPermissions(link1._id, userId, true);
    await grantCreationPermissions(link2._id, userId, true);

    const result = await deleteAllSharedLinksWithCleanup(userId);

    expect(result.deletedCount).toBe(2);

    await new Promise((r) => setTimeout(r, 100));
    const aclAfter = await AclEntry.find({
      resourceId: { $in: [link1._id, link2._id] },
    }).lean();
    expect(aclAfter).toHaveLength(0);
  });
});

import { eq, sql as dsql } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizationMembers } from "../schema/organizationMembers.js";
import { organizations } from "../schema/organizations.js";
import { sessionAccess } from "../schema/sessionAccess.js";

const SHARED_ORG_NAME = "Dev Org"; // the single shared org all accounts live in

async function ensureMembership(userId, isAdmin) {
  let [org] = await db.select().from(organizations).where(eq(organizations.name, SHARED_ORG_NAME)).limit(1);
  if (!org) {
    await db.execute(dsql`INSERT INTO organizations (name) VALUES (${SHARED_ORG_NAME})`);
    [org] = await db.select().from(organizations).where(eq(organizations.name, SHARED_ORG_NAME)).limit(1);
  }
  const role = isAdmin ? "admin" : "member";
  await db.execute(
    dsql`INSERT INTO organization_members (organization_id, user_id, role)
         VALUES (${org.id}, ${userId}, ${role})
         ON CONFLICT (organization_id, user_id) DO NOTHING`
  );
  return { organizationId: org.id, role };
}

/**
 * Requires req.user (from requireAuth). Ensures the user belongs to the shared org,
 * and attaches:
 *   req.organizationId, req.orgRole
 *   req.isAdmin              — true if the user's account role is 'admin'
 *   req.accessibleSessionIds — Set of session ids this user may view (null = all, for admins)
 */
export async function requireOrg(req, res, next) {
  try {
    if (!req.user?.id) return res.status(401).json({ error: "Not authenticated" });
    const isAdmin = req.user.role === "admin";

    let [membership] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, req.user.id))
      .limit(1);
    if (!membership) {
      const m = await ensureMembership(req.user.id, isAdmin);
      req.organizationId = m.organizationId;
      req.orgRole = m.role;
    } else {
      req.organizationId = membership.organizationId;
      req.orgRole = isAdmin ? "admin" : membership.role;
    }

    req.isAdmin = isAdmin;

    if (isAdmin) {
      req.accessibleSessionIds = null; // null = all sessions
    } else {
      const grants = await db
        .select({ sessionId: sessionAccess.sessionId })
        .from(sessionAccess)
        .where(eq(sessionAccess.userId, req.user.id));
      req.accessibleSessionIds = new Set(grants.map((g) => g.sessionId));
    }

    next();
  } catch (err) {
    next(err);
  }
}

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizationMembers } from "../schema/organizationMembers.js";

/**
 * Requires req.user (from requireAuth). Loads the user's single organization membership.
 * Sets req.organizationId and req.orgRole; if user has no membership, returns 403.
 * Attach after requireAuth on CRM routes.
 */
export async function requireOrg(req, res, next) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const [membership] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, req.user.id))
      .limit(1);
    if (!membership) {
      return res.status(403).json({ error: "No organization. Join or create one first." });
    }
    req.organizationId = membership.organizationId;
    req.orgRole = membership.role;
    next();
  } catch (err) {
    next(err);
  }
}

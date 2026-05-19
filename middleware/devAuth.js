import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizations } from "../schema/organizations.js";
import { users } from "../schema/users.js";
import { organizationMembers } from "../schema/organizationMembers.js";
import { uuidv7 } from "uuidv7";

/**
 * Dev-mode auth stub for aiowa.
 *
 * The product is a *shared* multi-session WhatsApp operator — any client on the
 * network should be able to use any linked session. No JWT, no per-user ACLs.
 * We still need to satisfy the DB's NOT NULL constraints on organization_id
 * and created_by, so we bootstrap a single "aiowa" org + user on first hit
 * and inject their IDs into req.user / req.organizationId.
 */

let cached = null;

async function bootstrap() {
  if (cached) return cached;

  // Create user first (org's createdBy FK depends on it)
  let [user] = await db.select().from(users).where(eq(users.username, "aiowa")).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({
      id: uuidv7(),
      username: "aiowa",
      fullName: "Aiowa Bot",
      email: "aiowa@local.invalid",
      password: "!",
      passwordHash: "!",
    }).returning();
  }

  let [org] = await db.select().from(organizations).where(eq(organizations.name, "aiowa")).limit(1);
  if (!org) {
    [org] = await db.insert(organizations).values({
      id: uuidv7(),
      name: "aiowa",
      joinCode: `aiowa-${uuidv7().slice(0, 8)}`,
      createdBy: user.id,
    }).returning();
  }

  const [membership] = await db.select().from(organizationMembers)
    .where(and(
      eq(organizationMembers.organizationId, org.id),
      eq(organizationMembers.userId, user.id),
    )).limit(1);
  if (!membership) {
    await db.insert(organizationMembers).values({
      id: uuidv7(),
      organizationId: org.id,
      userId: user.id,
      role: "admin",
    });
  }

  cached = { org, user };
  return cached;
}

export async function devAuth(req, res, next) {
  try {
    const { org, user } = await bootstrap();
    const { password: _p, passwordHash: _h, ...rest } = user;
    req.user = rest;
    req.organizationId = org.id;
    req.orgRole = "admin";
    next();
  } catch (err) {
    console.error("[devAuth] bootstrap failed:", err.message);
    res.status(500).json({ error: "Dev-auth bootstrap failed: " + err.message });
  }
}

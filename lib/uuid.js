import { uuidv7 } from "uuidv7";
import { uuid } from "drizzle-orm/pg-core";

/**
 * UUIDv7 primary key column for Drizzle schemas.
 * Usage: id: pkv7(),
 */
export const pkv7 = () => uuid("id").primaryKey().$defaultFn(() => uuidv7())

export { uuidv7 };

import express from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import * as admin from "../controller/adminController.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get("/users", admin.listUsers);
router.patch("/users/:userId", admin.updateUser);
router.get("/users/:userId/access", admin.getUserAccess);
router.put("/users/:userId/access", admin.setUserAccess);
router.get("/accounts", admin.listAccounts);

export default router;

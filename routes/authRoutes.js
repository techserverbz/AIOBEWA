import express from "express";
import * as authController from "../controller/authController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.post("/login", authController.login);
router.post("/otp/send-signup", authController.sendOtpSignup);
router.post("/signup", authController.signup);
router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password", authController.resetPassword);
router.post("/forgot-username", authController.forgotUsername);
router.post("/recover-username", authController.recoverUsername);
router.get("/me", authController.getMe);
router.patch("/me", requireAuth, authController.updateMe);

export default router;

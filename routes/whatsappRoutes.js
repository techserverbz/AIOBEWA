import express from "express";
import { devAuth } from "../middleware/devAuth.js";
import * as wa from "../controller/whatsappController.js";

const router = express.Router();

// Shared-access: no JWT, a single bootstrapped org+user serves every client.
router.use(devAuth);

// Session CRUD
router.get("/", wa.listSessions);
router.post("/", wa.createSession);
router.delete("/:id", wa.deleteSession);

// Session lifecycle
router.post("/:id/start", wa.startSession);
router.post("/:id/stop", wa.stopSession);
router.get("/:id/qr", wa.getQR);
router.get("/:id/status", wa.getStatus);

// Messaging
router.post("/:id/send", wa.sendMessage);
router.post("/:id/send-media", wa.sendMedia);
router.get("/:id/messages", wa.listMessages);

// Chat history
router.get("/:id/chats", wa.getChats);
router.get("/:id/chats/:contactId", wa.getChatMessages);

// Manual backfill trigger (idempotent, safe to call multiple times)
router.post("/:id/backfill", wa.backfillMessages);

// On-demand media stream (served as attachment for download)
router.get("/:id/media/:messageId", wa.streamMedia);

export default router;

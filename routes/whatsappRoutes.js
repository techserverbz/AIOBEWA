import express from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";
import { requireOrg } from "../middleware/requireOrg.js";
import * as wa from "../controller/whatsappController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(requireAuth);
router.use(requireOrg);

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
router.post("/:id/send-media", upload.single("file"), wa.sendMedia);
router.get("/:id/messages", wa.listMessages);

// Sync (refresh live chat cache from wwebjs)
router.post("/:id/backfill", wa.backfill);
router.get("/:id/_debug", wa.debugStore);
router.post("/:id/_debug-msgs/:contactId", wa.debugChatMessages);

// Chat history
router.get("/:id/chats", wa.getChats);
router.get("/:id/chats/:contactId", wa.getChatMessages);

// On-demand media (preview — no S3)
router.get("/:id/media/:messageId", wa.streamMedia);

// Save media to S3 (explicit user action, with notes)
router.post("/:id/media/:messageId/save", wa.saveMedia);

export default router;

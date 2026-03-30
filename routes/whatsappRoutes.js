import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireOrg } from "../middleware/requireOrg.js";
import * as wa from "../controller/whatsappController.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireOrg);

router.get("/", wa.listSessions);
router.post("/", wa.createSession);
router.delete("/:id", wa.deleteSession);

router.post("/:id/start", wa.startSession);
router.post("/:id/stop", wa.stopSession);
router.get("/:id/qr", wa.getQR);
router.get("/:id/status", wa.getStatus);

router.post("/:id/send", wa.sendMessage);
router.post("/:id/send-media", wa.sendMedia);
router.get("/:id/messages", wa.listMessages);
router.get("/:id/chats", wa.getChats);
router.get("/:id/chats/:contactId", wa.getChatMessages);

export default router;

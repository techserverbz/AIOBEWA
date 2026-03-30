import "dotenv/config";
import express from "express";
import { ensureWhatsappSchema } from "./db/ensureWhatsappSchema.js";
import whatsappRoutes from "./routes/whatsappRoutes.js";
import { handleWebhook } from "./controller/whatsappController.js";
import { whatsappManager } from "./lib/whatsappManager.js";

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "whatsapp", sessions: whatsappManager.connections.size });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "whatsapp", activeSessions: whatsappManager.connections.size });
});

// WhatsApp routes (auth + org required)
app.use("/sessions", whatsappRoutes);

// Webhook (public — no auth, Meta needs to reach it)
app.get("/webhook", handleWebhook);
app.post("/webhook", handleWebhook);

// Error handler
app.use((err, req, res, next) => {
  console.error("[WA ERROR]", new Date().toISOString(), req.method, req.originalUrl, err.message);
  res.status(err.status || 500).json({ error: err.message });
});

const PORT = 8002;
ensureWhatsappSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WhatsApp service running on http://localhost:${PORT}`);
      // Auto-reconnect Baileys sessions
      whatsappManager.reconnectAll().catch((err) => {
        console.error("WhatsApp reconnect failed:", err.message);
      });
    });
  })
  .catch((err) => {
    console.error("WhatsApp service startup failed:", err.message);
    process.exit(1);
  });

export default app;

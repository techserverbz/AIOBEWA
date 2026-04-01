import "dotenv/config";
import express from "express";
import { ensureWhatsappSchema } from "./db/ensureWhatsappSchema.js";
import whatsappRoutes from "./routes/whatsappRoutes.js";
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
  res.json({ status: "ok", service: "whatsapp-wwebjs", sessions: whatsappManager.clients.size });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "whatsapp-wwebjs", activeSessions: whatsappManager.clients.size });
});

// WhatsApp routes (auth + org required)
app.use("/sessions", whatsappRoutes);

// Error handler
app.use((err, _req, res, _next) => {
  console.error("[WA ERROR]", new Date().toISOString(), err.message);
  res.status(err.status || 500).json({ error: err.message });
});

const PORT = 8002;
ensureWhatsappSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WhatsApp service running on http://localhost:${PORT}`);
      // Auto-reconnect previously connected wwebjs sessions (non-blocking)
      whatsappManager.autoReconnect().catch((err) => {
        console.error("[WA] Auto-reconnect failed:", err.message);
      });
    });
  })
  .catch((err) => {
    console.error("WhatsApp service startup failed:", err.message);
    process.exit(1);
  });

export default app;

import express, { NextFunction, Request, Response } from "express";
import { pool } from "./db";
import { config } from "./config";
import { assignmentsRouter } from "./routes/assignments";
import { agentsRouter } from "./routes/agents";

export const app = express();
app.use(express.json());

// Liveness + DB connectivity check.
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "db_unavailable" });
  }
});

app.use("/api", assignmentsRouter);
app.use("/api", agentsRouter);

// Central error handler (Express detects it by its 4-arg signature).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // A malformed JSON body is thrown by express.json() as a SyntaxError with a
  // 400 status — surface it as a client error, not a 500.
  if (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status?: number }).status === 400
  ) {
    res
      .status(400)
      .json({ error: { code: "invalid_json", message: "malformed JSON body" } });
    return;
  }
  console.error(err);
  res
    .status(500)
    .json({ error: { code: "internal_error", message: "unexpected error" } });
});

// Only listen when run directly, so tests can import `app` without a live port.
if (require.main === module) {
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`server listening on :${config.port}`);
  });

  // Graceful shutdown: stop accepting connections, then drain the pool so the
  // process exits cleanly (and Postgres connections aren't left dangling).
  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

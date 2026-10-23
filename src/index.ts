import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import errorMiddleware from "./modules/config/errorHandler";
import importRoutings from "./routing/routingIndex";
import http from "http";
import * as path from "path";
import { setupSocket } from "./modules/chatSocket/chatSocket";
import { statusCode } from "./config/helper/statusCode";
import connectToDatabase from "./db/db";
import mongoose from "mongoose";
import { startLeaveAccrualScheduler } from "./services/leave/leaveAccrualScheduler";
import { recoverPendingAttendanceProcessorRuns } from "./services/attendance/attendanceProcessor.service";
import {
  runScheduledAttendanceProcessor,
  startAttendanceProcessorScheduler,
} from "./services/attendance/attendanceProcessorScheduler";
import {
  recoverPayrollOperationalJobs,
  startPayrollOperationsScheduler,
} from "./services/payroll/payrollOperationsScheduler";

dotenv.config();

const app = express();
const server = http.createServer(app);

const trustProxy = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
if (trustProxy === "true") {
  app.set("trust proxy", true);
} else if (/^\d+$/.test(trustProxy)) {
  app.set("trust proxy", Number(trustProxy));
}

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
  credentials: false,
  allowedHeaders: ["Content-Type", "Authorization", "X-Attendance-Device-Id", "Idempotency-Key"],
};

app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", (req: Request, res: Response) => {
  res.status(statusCode.success).json({
    message: "HRMS backend is running",
    health: "/health",
    apiBase: "/api",
  });
});

app.get("/api", (req: Request, res: Response) => {
  res.status(statusCode.success).json({
    message: "API base route is available",
    health: "/health",
  });
});

app.get("/health", (req: Request, res: Response) => {
  res.status(statusCode.success).send("Health OK");
});

app.get("/db-check", async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      readyState: mongoose.connection.readyState,
      uri: process.env.MONGODB_URI ? "Defined (redacted)" : "NOT DEFINED",
      error: error.message,
    });
  }

  const state = mongoose.connection.readyState;
  const states = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
    99: "uninitialized",
  };

  res.status(statusCode.success).json({
    status: (states as any)[state] || "unknown",
    readyState: state,
    uri: process.env.MONGODB_URI ? "Defined (redacted)" : "NOT DEFINED",
  });
});

app.use("/public", express.static(path.join(process.cwd(), "public")));

app.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connectToDatabase();
    next();
  } catch (error: any) {
    console.error("Database bootstrap failed:", error.message);
    res.status(500).json({ error: "Database connection failed" });
  }
});

importRoutings(app);

app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, message: "API route not found" });
});

app.use(errorMiddleware);

const startServer = async () => {
  try {
    await connectToDatabase();

    const PORT = process.env.PORT || 5000;
    setupSocket(server);
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      startLeaveAccrualScheduler();
      const attendanceSchedulerStarted = startAttendanceProcessorScheduler();
      startPayrollOperationsScheduler();
      recoverPayrollOperationalJobs()
        .then((count) => {
          if (count) console.log(`Recovered ${count} payroll operations job(s)`);
        })
        .catch((error: any) => {
          console.error("Payroll operations recovery failed:", error?.message || error);
        });
      recoverPendingAttendanceProcessorRuns()
        .then(async (count) => {
          if (count) console.log(`Recovered ${count} pending attendance processor run(s)`);
          if (!attendanceSchedulerStarted) return;
          const catchup = await runScheduledAttendanceProcessor();
          if (catchup.queued.length) {
            console.log(
              `Queued ${catchup.queued.length} attendance catch-up run(s) across ${catchup.companies} company account(s)`
            );
          }
        })
        .catch((error: any) => {
          console.error("Attendance processor recovery failed:", error?.message || error);
        });
    });
  } catch (error) {
    console.error("Failed to start server:", error);
  }
};

if (require.main === module && !process.env.VERCEL) {
  startServer();
}

export default app;

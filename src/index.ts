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
import { serveCourseAsset } from "./services/scorm/scormStorage.service";

dotenv.config();

const app = express();
const server = http.createServer(app);

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
  credentials: false,
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", (req: Request, res: Response) => {
  res.status(statusCode.info).json({
    message: "LMS backend is running",
    health: "/health",
    apiBase: "/api",
  });
});

app.get("/api", (req: Request, res: Response) => {
  res.status(statusCode.info).json({
    message: "API base route is available",
    health: "/health",
  });
});

app.get("/health", (req: Request, res: Response) => {
  res.status(statusCode.info).send("Health OK");
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

  res.status(statusCode.info).json({
    status: (states as any)[state] || "unknown",
    readyState: state,
    uri: process.env.MONGODB_URI ? "Defined (redacted)" : "NOT DEFINED",
  });
});

app.get("/courses/*", async (req: Request, res: Response) => {
  try {
    const assetPath = req.path.replace(/^\/courses\/?/, "");
    const wasServed = await serveCourseAsset(assetPath, res);

    if (!wasServed) {
      res.status(404).send("Course asset not found");
    }
  } catch (error) {
    console.error("Course asset serve error:", error);
    res.status(500).send("Failed to load course asset");
  }
});

app.use("/notes", express.static(path.join(__dirname, "src", "../public/notes")));
app.use("/public", express.static(path.join(process.cwd(), "public")));

app.get("/courses-debug", (req: Request, res: Response) => {
  const coursesDir = path.join(process.cwd(), "public", "uploads", "courses");
  const fs = require("fs");

  try {
    const dirs = fs.readdirSync(coursesDir);
    res.json({ coursesDir, contents: dirs });
  } catch (err: any) {
    res.json({ coursesDir, error: err.message });
  }
});

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
  res.status(404).send("Welcome to our app 4 (Not Found)");
});

app.use(errorMiddleware);

const startServer = async () => {
  try {
    await connectToDatabase();

    const PORT = process.env.PORT || 5000;
    setupSocket(server);
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
  }
};

if (!process.env.VERCEL) {
  startServer();
}

export default app;

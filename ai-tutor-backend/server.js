const express = require("express");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const connectDB = require("./config/db");
const interviewRoutes = require("./routes/interviewRoutes");
const { notFound, errorHandler } = require("./middleware/errorMiddleware");

dotenv.config();

const app = express();
const FRONTEND_DIST_PATH = path.resolve(__dirname, "..", "ai-tutor-frontend", "dist");
const FRONTEND_INDEX_PATH = path.join(FRONTEND_DIST_PATH, "index.html");
const hasFrontendBuild = fs.existsSync(FRONTEND_INDEX_PATH);

connectDB();

app.disable("x-powered-by");
app.set("trust proxy", 1);

const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

const configuredOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...configuredOrigins])];

const isDevLocalOrigin = (origin) => {
  try {
    const url = new URL(origin);
    const hostnameAllowed =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const portAllowed = ["5173", "4173", "4174", "3000"].includes(url.port);

    return hostnameAllowed && portAllowed;
  } catch {
    return false;
  }
};

app.use(helmet());
app.use(
  cors((req, callback) => {
    const origin = req.header("origin");
    const forwardedProto = (req.header("x-forwarded-proto") || req.protocol || "http")
      .split(",")[0]
      .trim();
    const currentOrigin = `${forwardedProto}://${req.get("host")}`;
    const allowOrigin =
      !origin ||
      allowedOrigins.includes(origin) ||
      isDevLocalOrigin(origin) ||
      origin === currentOrigin;

    if (allowOrigin) {
      callback(null, {
        origin: true,
        credentials: true,
      });
      return;
    }

    const error = new Error(`Origin not allowed by CORS: ${origin}`);
    error.statusCode = 403;
    callback(error, {
      origin: false,
      credentials: true,
    });
  })
);
app.use(morgan("dev"));
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    environment: process.env.NODE_ENV || "development",
    frontend: hasFrontendBuild ? "bundled" : "separate",
    openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/interviews", interviewRoutes);

if (hasFrontendBuild) {
  app.use(express.static(FRONTEND_DIST_PATH));

  app.get(/^\/(?!api|health).*/, (req, res) => {
    res.sendFile(FRONTEND_INDEX_PATH);
  });
} else {
  app.get("/", (req, res) => {
    res.json({
      message: "AI Tutor Backend API is running",
      frontend: "Build the frontend and serve this backend for production.",
    });
  });
}

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

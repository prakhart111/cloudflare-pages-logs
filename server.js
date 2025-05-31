const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const bcrypt = require("bcrypt");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudflare API configuration
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DEPLOYMENT_ID = process.env.CLOUDFLARE_DEPLOYMENT_ID;
const PROJECT_NAME = process.env.CLOUDFLARE_PROJECT_NAME;

const CLOUDFLARE_API_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}/deployments/${DEPLOYMENT_ID}/tails`;

// WebSocket configuration
let WS_URL = "";
const WS_HEADERS = {
  Host: "tail.developers.workers.dev",
  Connection: "Upgrade",
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Upgrade: "websocket",
  Origin: "https://dash.cloudflare.com",
  "Sec-WebSocket-Version": "13",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7",
  "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
  "Sec-WebSocket-Protocol": "trace-v1",
};

// Global state management
const logManager = new EventEmitter();
let wsClient = null;
let isConnecting = false;
let connectionStatus = "disconnected";
let lastError = null;
let logCount = 0;
let autoConnectEnabled = true;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 2;
let reconnectTimeout = null;

// Ensure logs directory exists
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Middleware
app.use(express.static("public"));
app.use(express.json());

// Utility functions
function getCurrentLogFileName() {
  return `cf-logs-${new Date()
    .toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })
    .split(",")[0]
    .split("/")
    .join("-")}.jsonl`;
}

function saveLogToFile(logData) {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      data: logData,
    };
    const currentLogFile = path.join(logsDir, getCurrentLogFileName());
    fs.appendFileSync(currentLogFile, JSON.stringify(logEntry) + "\n");
    logCount++;

    // Emit status update with the new log count
    logManager.emit("statusUpdate", {
      status: connectionStatus,
      error: lastError,
      logCount,
      wsUrl: WS_URL,
      autoConnectEnabled,
      reconnectAttempts,
    });
  } catch (error) {
    console.error("Error saving log to file:", error);
    lastError = `Failed to save log: ${error.message}`;
    logManager.emit("error", lastError);
  }
}

function updateStatus(status, error = null) {
  connectionStatus = status;
  lastError = error;
  logManager.emit("statusUpdate", {
    status,
    error,
    logCount,
    wsUrl: WS_URL,
    autoConnectEnabled,
    reconnectAttempts,
  });
}

async function fetchNewWebSocketURL() {
  try {
    console.log("Fetching new WebSocket URL from Cloudflare API...");

    const response = await fetch(CLOUDFLARE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Email": process.env.CLOUDFLARE_EMAIL,
        "X-Auth-Key": process.env.CLOUDFLARE_API_KEY,
      },
      body: JSON.stringify({
        filters: [],
      }),
    });

    const data = await response.json();
    console.log(data);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (data.success && data.result && data.result.url) {
      WS_URL = data.result.url;
      console.log(`New WebSocket URL obtained: ${WS_URL}`);
      return WS_URL;
    } else {
      throw new Error(
        `API response error: ${JSON.stringify(data.errors || "Unknown error")}`
      );
    }
  } catch (error) {
    console.error("Failed to fetch new WebSocket URL:", error);
    lastError = `Failed to fetch new WebSocket URL: ${error.message}`;
    logManager.emit("error", lastError);
    return null;
  }
}

async function connectWebSocket(isAutoReconnect = false) {
  if (isConnecting || (wsClient && wsClient.readyState === WebSocket.OPEN)) {
    return { success: false, message: "Already connected or connecting" };
  }

  isConnecting = true;

  // Update status based on whether this is an auto-reconnect attempt
  if (isAutoReconnect) {
    updateStatus("auto-reconnecting");
  } else {
    updateStatus("connecting");
  }

  try {
    // First, fetch a new WebSocket URL
    const newUrl = await fetchNewWebSocketURL();
    if (!newUrl) {
      isConnecting = false;

      if (isAutoReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        scheduleReconnect();
        return {
          success: false,
          message: "Failed to fetch WebSocket URL, will retry",
        };
      } else {
        updateStatus(
          "error",
          "Failed to fetch WebSocket URL after maximum retries"
        );
        return { success: false, message: "Failed to fetch WebSocket URL" };
      }
    }

    wsClient = new WebSocket(WS_URL, ["trace-v1"], {
      headers: WS_HEADERS,
    });

    wsClient.on("open", () => {
      console.log("WebSocket connected successfully");
      isConnecting = false;
      reconnectAttempts = 0; // Reset attempts on successful connection
      updateStatus("connected");
    });

    wsClient.on("message", (data) => {
      try {
        // Convert binary data to JSON
        let jsonData;
        if (Buffer.isBuffer(data)) {
          jsonData = JSON.parse(data.toString("utf8"));
        } else {
          jsonData = JSON.parse(data);
        }

        // More lenient filtering: save all logs that have basic event data
        const hasEventData =
          (jsonData.logs && jsonData.logs.length > 0) ||
          (jsonData.exceptions && jsonData.exceptions.length > 0);

        if (hasEventData) {
          saveLogToFile(jsonData);
          logManager.emit("newLog", jsonData);
        } else {
          // Log what's being filtered for debugging
          // console.log(
          //   "Filtered log (no event data):",
          //   JSON.stringify(jsonData).substring(0, 200) + "..."
          // );
        }
      } catch (error) {
        console.error("Error parsing WebSocket message:", error);
        lastError = `Error parsing message: ${error.message}`;
        logManager.emit("error", lastError);
      }
    });

    wsClient.on("close", (code, reason) => {
      console.log(`WebSocket closed: ${code} ${reason}`);
      isConnecting = false;
      updateStatus("disconnected");

      // Auto-reconnect if enabled and we haven't exceeded max attempts
      if (autoConnectEnabled && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        scheduleReconnect();
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        updateStatus(
          "error",
          `Connection lost and failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`
        );
      }
    });

    wsClient.on("error", (error) => {
      console.error("WebSocket error:", error);
      isConnecting = false;
      const errorMsg = `WebSocket error: ${error.message}`;

      if (autoConnectEnabled && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        scheduleReconnect();
        updateStatus("auto-reconnecting", errorMsg);
      } else {
        updateStatus("error", errorMsg);
      }
    });

    return { success: true, message: "Connection initiated" };
  } catch (error) {
    console.error("Error creating WebSocket:", error);
    isConnecting = false;

    if (isAutoReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      scheduleReconnect();
      updateStatus("auto-reconnecting", `Connection failed: ${error.message}`);
      return {
        success: false,
        message: `Connection failed: ${error.message}, will retry`,
      };
    } else {
      updateStatus("error", `Connection failed: ${error.message}`);
      return { success: false, message: `Connection failed: ${error.message}` };
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  reconnectAttempts++;
  const delay = Math.min(5000 * reconnectAttempts, 30000); // Exponential backoff, max 30s

  console.log(
    `Scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`
  );

  reconnectTimeout = setTimeout(() => {
    if (autoConnectEnabled && reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      connectWebSocket(true);
    }
  }, delay);
}

async function disconnectWebSocket() {
  autoConnectEnabled = false; // Disable auto-reconnect

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (wsClient) {
    await wsClient.close();
    wsClient = null;
  }
  updateStatus("disconnected");
}

function enableAutoConnect() {
  autoConnectEnabled = true;
  reconnectAttempts = 0;
  if (connectionStatus !== "connected" && connectionStatus !== "connecting") {
    connectWebSocket();
  }
}

// API Routes
app.get("/api/log-files", (req, res) => {
  try {
    const files = fs
      .readdirSync(logsDir)
      .filter((file) => file.startsWith("cf-logs-") && file.endsWith(".jsonl"))
      .map((file) => {
        const stats = fs.statSync(path.join(logsDir, file));
        return {
          name: file,
          size: stats.size,
          modified: stats.mtime,
          isToday: file === getCurrentLogFileName(),
        };
      })
      .sort((a, b) => b.modified - a.modified); // Sort by newest first

    res.json(files);
  } catch (error) {
    console.error("Failed to list log files:", error);
    res.status(500).json({ error: "Failed to list log files" });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    status: connectionStatus,
    error: lastError,
    logCount,
    logFilePath: path.join(logsDir, getCurrentLogFileName()),
    wsUrl: WS_URL,
    autoConnectEnabled,
    reconnectAttempts,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
  });
});

app.post("/api/connect", async (req, res) => {
  enableAutoConnect();
  const result = await connectWebSocket();
  res.json(result);
});

app.post("/api/disconnect", async (req, res) => {
  // first check current status
  const currentStatus = connectionStatus;
  if (currentStatus === "disconnected") {
    res.json({ message: "Already disconnected" });
    return;
  }
  await disconnectWebSocket();
  res.json({ message: "Disconnected and auto-connect disabled" });
});

app.post("/api/enable-auto-connect", async (req, res) => {
  enableAutoConnect();
  res.json({ message: "Auto-connect enabled" });
});

app.post("/api/login", async (req, res) => {
  const { password: hashedPasswordFromClient } = req.body;
  console.log(hashedPasswordFromClient);
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    console.error("ADMIN_PASSWORD environment variable is not set.");
    return res.status(500).json({
      error: "Server configuration error. Please contact administrator.",
    });
  }
  if (!hashedPasswordFromClient) {
    return res
      .status(400)
      .json({ error: "Password hash is required from client." });
  }

  try {
    const match = await bcrypt.compare(adminPassword, hashedPasswordFromClient);
    if (match) {
      // IMPORTANT: In a real app, you'd issue a session token here.
      // For this example, we'll just send a success message.
      res.status(200).json({ message: "Login successful." });
    } else {
      res.status(401).json({ error: "Invalid credentials." });
    }
  } catch (error) {
    console.error("Error during password comparison:", error);
    // Log the specific bcrypt error if available, but don't send details to client
    if (error.message) {
      console.error("Bcrypt error message:", error.message);
    }
    res.status(500).json({ error: "Server error during login process." });
  }
});

app.get("/api/logs", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.per_page) || 25;
    const limit = parseInt(req.query.limit); // For backward compatibility
    const requestedFile = req.query.file; // New parameter for file selection

    // Determine which log file to read from
    let targetLogFile;
    if (requestedFile) {
      // Validate the requested file exists and is in the logs directory
      const sanitizedFile = path.basename(requestedFile); // Remove any path traversal
      targetLogFile = path.join(logsDir, sanitizedFile);

      if (
        !fs.existsSync(targetLogFile) ||
        !sanitizedFile.startsWith("cf-logs-") ||
        !sanitizedFile.endsWith(".jsonl")
      ) {
        return res.status(400).json({ error: "Invalid log file specified" });
      }
    } else {
      // Default to current log file
      targetLogFile = path.join(logsDir, getCurrentLogFileName());
    }

    if (fs.existsSync(targetLogFile)) {
      const data = fs.readFileSync(targetLogFile, "utf8");
      const lines = data
        .trim()
        .split("\n")
        .filter((line) => line);

      const totalLogs = lines.length;

      // If limit is provided (backward compatibility), use old behavior
      if (limit) {
        const logs = lines.slice(-limit).map((line) => JSON.parse(line));
        res.json(logs);
        return;
      }

      // Calculate pagination
      const totalPages = Math.ceil(totalLogs / perPage);
      const startIndex = (page - 1) * perPage;
      const endIndex = startIndex + perPage;

      // Get logs for current page (reverse order for newest first)
      const reversedLines = lines.slice().reverse();
      const paginatedLines = reversedLines.slice(startIndex, endIndex);
      const logs = paginatedLines.map((line) => JSON.parse(line));

      res.json({
        logs,
        pagination: {
          currentPage: page,
          perPage,
          totalLogs,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
          startIndex: startIndex + 1,
          endIndex: Math.min(endIndex, totalLogs),
        },
        file: path.basename(targetLogFile),
        isCurrentFile:
          targetLogFile === path.join(logsDir, getCurrentLogFileName()),
      });
    } else {
      res.json({
        logs: [],
        pagination: {
          currentPage: 1,
          perPage,
          totalLogs: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
          startIndex: 0,
          endIndex: 0,
        },
        file: requestedFile
          ? path.basename(targetLogFile)
          : getCurrentLogFileName(),
        isCurrentFile:
          targetLogFile === path.join(logsDir, getCurrentLogFileName()),
      });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to read logs" });
  }
});

// SSE endpoint for real-time updates
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial status
  res.write(
    `data: ${JSON.stringify({
      type: "status",
      payload: {
        status: connectionStatus,
        error: lastError,
        logCount,
        wsUrl: WS_URL,
        autoConnectEnabled,
        reconnectAttempts,
      },
    })}\n\n`
  );

  const onStatusUpdate = (data) => {
    res.write(`data: ${JSON.stringify({ type: "status", payload: data })}\n\n`);
  };

  const onNewLog = (log) => {
    res.write(`data: ${JSON.stringify({ type: "log", payload: log })}\n\n`);
  };

  const onError = (error) => {
    res.write(`data: ${JSON.stringify({ type: "error", payload: error })}\n\n`);
  };

  logManager.on("statusUpdate", onStatusUpdate);
  logManager.on("newLog", onNewLog);
  logManager.on("error", onError);

  req.on("close", () => {
    logManager.removeListener("statusUpdate", onStatusUpdate);
    logManager.removeListener("newLog", onNewLog);
    logManager.removeListener("error", onError);
  });
});

// Serve the dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(
    `Logs will be saved to: ${path.join(logsDir, getCurrentLogFileName())}`
  );

  // Auto-connect on server start
  console.log("Starting auto-connect...");
  setTimeout(() => {
    enableAutoConnect();
  }, 2000); // Give server a moment to fully initialize
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down gracefully...");
  disconnectWebSocket();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\nShutting down gracefully...");
  disconnectWebSocket();
  process.exit(0);
});

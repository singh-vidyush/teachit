const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, net, protocol, session } = require("electron");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Keep the existing local boards made by the first app build after the rename.
app.setPath("userData", path.join(app.getPath("appData"), "excalidraw-whiteboard"));

protocol.registerSchemesAsPrivileged([
  {
    scheme: "whiteboard",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const appRoot = path.resolve(app.getAppPath(), "dist");
const supportedFile = (filePath) => [".excalidraw", ".excalidrawlib"].includes(path.extname(filePath).toLowerCase());
let mainWindow;
let windowReady = false;
const queuedSceneFiles = [];
let recordingWriter;
let recordingPath;

function isMainWindow(webContents) {
  return mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents;
}

function setRecordingTarget() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (!mainWindow || mainWindow.isDestroyed()) return callback(null);
    try {
      const expectedId = mainWindow.getMediaSourceId();
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const appSource = sources.find((source) => source.id === expectedId);
      callback(appSource ? { video: appSource } : null);
    } catch (error) {
      console.error("Could not capture the TeachIt window.", error);
      callback(null);
    }
  });
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!isMainWindow(webContents)) return callback(false);
    if (permission === "media") {
      const requested = details.mediaTypes ?? [];
      return callback(requested.every((type) => type === "audio" || type === "video"));
    }
    if (permission === "display-capture") return callback(true);
    callback(false);
  });
}

function closeRecordingWriter() {
  const writer = recordingWriter;
  recordingWriter = undefined;
  recordingPath = undefined;
  if (!writer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.once("finish", resolve);
    writer.end();
  });
}

ipcMain.handle("teachit:recording-start", async (event, mimeType) => {
  if (!isMainWindow(event.sender) || recordingWriter) return { error: "A recording is already active." };
  if (typeof mimeType !== "string" || !mimeType.startsWith("video/mp4")) {
    return { error: "TeachIt recording is configured for MP4 video." };
  }
  const timestamp = new Date().toISOString().replace(/[T:]/g, "-").replace(/\.\d+Z$/, "Z");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save TeachIt recording",
    defaultPath: path.join(app.getPath("videos"), `TeachIt-Recording-${timestamp}.mp4`),
    filters: [{ name: "MPEG-4 Video", extensions: ["mp4"] }],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  recordingPath = result.filePath.toLowerCase().endsWith(".mp4") ? result.filePath : `${result.filePath}.mp4`;
  recordingWriter = createWriteStream(recordingPath, { flags: "w" });
  try {
    await once(recordingWriter, "open");
  } catch (error) {
    recordingWriter = undefined;
    recordingPath = undefined;
    throw error;
  }
  return { cancelled: false };
});

ipcMain.handle("teachit:recording-chunk", async (event, data) => {
  if (!isMainWindow(event.sender) || !recordingWriter) throw new Error("No TeachIt recording is active.");
  const writer = recordingWriter;
  if (!writer.write(Buffer.from(data))) await once(writer, "drain");
});

ipcMain.handle("teachit:recording-finish", async (event) => {
  if (!isMainWindow(event.sender) || !recordingWriter) return { filePath: null };
  const savedPath = recordingPath;
  await closeRecordingWriter();
  return { filePath: savedPath };
});

ipcMain.handle("teachit:recording-cancel", async (event) => {
  if (!isMainWindow(event.sender) || !recordingWriter) return;
  const cancelledPath = recordingPath;
  const writer = recordingWriter;
  recordingWriter = undefined;
  recordingPath = undefined;
  writer.destroy();
  await once(writer, "close").catch(() => undefined);
  if (cancelledPath) await fs.rm(cancelledPath, { force: true });
});

function queueSceneFile(filePath) {
  if (!supportedFile(filePath)) return;
  queuedSceneFiles.push(filePath);
  void sendQueuedSceneFiles();
}

async function sendQueuedSceneFiles() {
  if (!windowReady || !mainWindow || mainWindow.isDestroyed()) return;
  while (queuedSceneFiles.length > 0) {
    const filePath = queuedSceneFiles.shift();
    try {
      const content = await fs.readFile(filePath, "utf8");
      mainWindow.webContents.send("teachit:open-file", {
        name: path.basename(filePath),
        content,
      });
    } catch (error) {
      console.error(`Could not open ${filePath}`, error);
    }
  }
}

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  queueSceneFile(filePath);
});

for (const argument of process.argv.slice(1)) {
  if (supportedFile(argument)) queueSceneFile(argument);
}

function resolveAppFile(url) {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const requestedPath = path.resolve(appRoot, `.${pathname}`);
  if (requestedPath !== appRoot && !requestedPath.startsWith(`${appRoot}${path.sep}`)) {
    return path.join(appRoot, "index.html");
  }
  return requestedPath;
}

async function createWindow() {
  configureMediaPermissions();
  setRecordingTarget();
  await protocol.handle("whiteboard", (request) => {
    const filePath = resolveAppFile(request.url);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    title: "TeachIt",
    backgroundColor: "#f8f9fa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.webContents.on("did-finish-load", () => {
    windowReady = true;
    void sendQueuedSceneFiles();
  });
  await mainWindow.loadURL("whiteboard://app/index.html");
}

ipcMain.on("teachit:ready", () => void sendQueuedSceneFiles());

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    windowReady = false;
    createWindow();
  }
});

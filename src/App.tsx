import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  loadLibraryFromBlob,
  mergeLibraryItems,
  restore,
  useHandleLibrary,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";
import { TeachItCanvas } from "./TeachItCanvas";

const DATABASE = "excalidraw-whiteboard";
const STORE = "scene";
const SCENE_KEY = "current";
const LIBRARY_KEY = "library-items";

let databasePromise: Promise<IDBDatabase> | undefined;

function openSceneStore(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Whiteboard storage is blocked."));
  });
  return databasePromise;
}

async function readScene() {
  return readStoredValue(SCENE_KEY);
}

async function readStoredValue(key: string) {
  const db = await openSceneStore();
  return new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeStoredValue(key: string, value: unknown) {
  const db = await openSceneStore();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

const libraryAdapter: LibraryPersistenceAdapter = {
  async load() {
    const libraryItems = (await readStoredValue(LIBRARY_KEY)) as LibraryItems | undefined;
    return libraryItems ? { libraryItems } : null;
  },
  async save({ libraryItems }) {
    await writeStoredValue(LIBRARY_KEY, libraryItems);
  },
};

type SavedScene = {
  elements: readonly OrderedExcalidrawElement[];
  appState: Pick<
    AppState,
    | "currentItemBackgroundColor"
    | "currentItemFillStyle"
    | "currentItemFontFamily"
    | "currentItemFontSize"
    | "currentItemOpacity"
    | "currentItemRoughness"
    | "currentItemStrokeColor"
    | "currentItemStrokeStyle"
    | "currentItemStrokeWidth"
    | "currentItemTextAlign"
    | "gridModeEnabled"
    | "gridSize"
    | "scrollX"
    | "scrollY"
    | "theme"
    | "viewBackgroundColor"
    | "zoom"
    | "zenModeEnabled"
  >;
  files: BinaryFiles;
};

type DesktopBridge = {
  onOpenFile: (callback: (file: { name: string; content: string }) => void) => () => void;
  startRecording: (mimeType: string) => Promise<{ cancelled?: boolean; error?: string }>;
  writeRecordingChunk: (data: ArrayBuffer) => Promise<void>;
  finishRecording: () => Promise<{ filePath: string | null }>;
  cancelRecording: () => Promise<void>;
};

function getDesktopBridge() {
  return (window as Window & { teachItDesktop?: DesktopBridge }).teachItDesktop;
}

function CameraPreview({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const interaction = useRef<{
    mode: "drag" | "resize";
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 240, height: 135 });

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const onFramePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".teachit-camera-widget__resize")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = {
      mode: "drag",
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
    setPosition({ x: rect.left, y: rect.top });
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = {
      mode: "resize",
      startX: event.clientX,
      startY: event.clientY,
      offsetX: 0,
      offsetY: 0,
      width: rect.width,
      height: rect.height,
    };
    setPosition({ x: rect.left, y: rect.top });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const active = interaction.current;
    if (!active) return;
    if (active.mode === "resize") {
      setSize({
        width: Math.max(180, Math.min(600, active.width + event.clientX - active.startX)),
        height: Math.max(100, Math.min(500, active.height + event.clientY - active.startY)),
      });
      return;
    }
    setPosition({
      x: Math.max(8, Math.min(window.innerWidth - active.width - 8, event.clientX - active.offsetX)),
      y: Math.max(8, Math.min(window.innerHeight - active.height - 8, event.clientY - active.offsetY)),
    });
  };

  const stopInteraction = () => { interaction.current = null; };

  return (
    <aside
      className="teachit-camera-widget"
      style={{
        width: size.width,
        height: size.height,
        ...(position ? { left: position.x, top: position.y, bottom: "auto" } : {}),
      }}
      aria-label="Floating camera preview"
      onPointerDown={onFramePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopInteraction}
      onPointerCancel={stopInteraction}
    >
      <video ref={videoRef} className="teachit-camera-widget__video" autoPlay playsInline muted />
      <div
        className="teachit-camera-widget__resize"
        role="slider"
        aria-label="Resize camera frame"
        title="Drag to resize"
        onPointerDown={onResizePointerDown}
      />
    </aside>
  );
}

function formatRecorderError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Recording permission was denied. Allow TeachIt to use Screen Recording and Microphone in macOS Privacy & Security settings.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "TeachIt couldn't find a microphone or camera device.";
  }
  return error instanceof Error ? error.message : "TeachIt couldn't start the recording.";
}

async function importLibrariesInto(api: ExcalidrawImperativeAPI, files: File[]) {
  let items: LibraryItems = [];
  const failures: string[] = [];

  for (const file of files) {
    try {
      items = mergeLibraryItems(items, await loadLibraryFromBlob(file, "unpublished"));
    } catch {
      failures.push(file.name);
    }
  }

  if (items.length > 0) {
    await api.updateLibrary({
      libraryItems: items,
      merge: true,
      openLibraryMenu: true,
      defaultStatus: "unpublished",
    });
    api.setToast({
      message: `Added ${items.length} library ${items.length === 1 ? "item" : "items"}`,
      duration: 4000,
    });
  }
  if (failures.length > 0) {
    api.setToast({
      message: `Couldn't import ${failures.length} file${failures.length === 1 ? "" : "s"}: ${failures.join(", ")}`,
      closable: true,
      duration: 7000,
    });
  }
}

type ImportLibraryButtonProps = {
  api: ExcalidrawImperativeAPI | null;
};

function ImportLibraryButton({ api }: ImportLibraryButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const importFiles = async (files: FileList | File[]) => {
    if (!api || files.length === 0) return;
    setImporting(true);
    try {
      await importLibrariesInto(api, Array.from(files));
    } catch (error) {
      console.error("Could not add the selected Excalidraw libraries.", error);
      api.setToast({ message: "TeachIt couldn't add those libraries.", closable: true });
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="teachit-library-import">
      <button
        className="teachit-library-import__button"
        type="button"
        disabled={!api || importing}
        onClick={() => inputRef.current?.click()}
        title="Import one or more downloaded .excalidrawlib files"
      >
        {importing ? "Adding libraries…" : "Add library files"}
      </button>
      <input
        ref={inputRef}
        className="teachit-library-import__input"
        type="file"
        accept=".excalidrawlib,application/vnd.excalidrawlib+json"
        multiple
        aria-label="Choose Excalidraw library files"
        onChange={(event) => {
          if (event.currentTarget.files) void importFiles(event.currentTarget.files);
        }}
      />
    </div>
  );
}

export default function App() {
  const [canvasMode, setCanvasMode] = useState<"excalidraw" | "teachit">("excalidraw");
  const [initialData, setInitialData] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [recordingState, setRecordingState] = useState<"idle" | "starting" | "recording" | "stopping">("idle");
  const [recordingNotice, setRecordingNotice] = useState("");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingTracksRef = useRef<MediaStream[]>([]);
  const recordingWriteRef = useRef<Promise<void>>(Promise.resolve());
  const finalizingRecordingRef = useRef(false);
  const pendingScene = useRef<SavedScene | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const idleSave = useRef<number | undefined>(undefined);

  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter });

  useEffect(() => {
    let active = true;
    readScene()
      .then((scene) => {
        if (active) setInitialData(scene ?? {});
      })
      .catch((error) => {
        console.warn("Could not restore the local whiteboard.", error);
        if (active) setInitialData({});
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
      window.clearTimeout(saveTimer.current);
      if (idleSave.current !== undefined && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleSave.current);
      }
    };
  }, []);

  useEffect(() => () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingTracksRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  useEffect(() => {
    const desktop = (window as Window & { teachItDesktop?: DesktopBridge }).teachItDesktop;
    if (!desktop) return;
    return desktop.onOpenFile(({ name, content }) => {
      try {
        if (name.toLowerCase().endsWith(".excalidrawlib")) {
          const currentApi = apiRef.current;
          if (currentApi) {
            void importLibrariesInto(currentApi, [new File([content], name)]).catch((error) => {
              console.error("Could not add the opened Excalidraw library.", error);
              currentApi.setToast({ message: "TeachIt couldn't add that library.", closable: true });
            });
          }
          return;
        }
        const parsed: unknown = JSON.parse(content);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          (parsed as { type?: unknown }).type !== "excalidraw" ||
          !Array.isArray((parsed as { elements?: unknown }).elements) ||
          !apiRef.current
        ) {
          throw new Error("This file is not a valid Excalidraw drawing.");
        }
        const restored = restore(parsed as ImportedDataState, apiRef.current.getAppState(), null, {
          refreshDimensions: true,
        });
        if (Object.values(restored.files).length) {
          apiRef.current.addFiles(Object.values(restored.files));
        }
        apiRef.current.updateScene({
          elements: restored.elements,
          appState: restored.appState,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        apiRef.current.history.clear();
      } catch (error) {
        console.error("Could not open the selected Excalidraw file.", error);
          window.alert("TeachIt couldn't open that file. Choose a valid .excalidraw drawing or .excalidrawlib library.");
      }
    });
  }, []);

  const scheduleSave = (scene: SavedScene) => {
    pendingScene.current = scene;
    window.clearTimeout(saveTimer.current);
    if (idleSave.current !== undefined && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(idleSave.current);
    }
    saveTimer.current = window.setTimeout(() => {
      const save = () => {
        const currentScene = pendingScene.current;
        pendingScene.current = null;
        if (currentScene) {
          void writeStoredValue(SCENE_KEY, currentScene).catch((error) =>
            console.warn("Could not save the local whiteboard.", error),
          );
        }
      };
      if ("requestIdleCallback" in window) {
        idleSave.current = window.requestIdleCallback(save, { timeout: 1800 });
      } else {
        save();
      }
    }, 900);
  };

  const toggleCamera = async () => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraStream(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 24, max: 30 },
        },
        audio: false,
      });
      cameraStreamRef.current = stream;
      setCameraStream(stream);
      setRecordingNotice("");
    } catch (error) {
      setRecordingNotice(formatRecorderError(error));
    }
  };

  const finishRecording = async () => {
    if (finalizingRecordingRef.current) return;
    finalizingRecordingRef.current = true;
    const desktop = getDesktopBridge();
    try {
      await recordingWriteRef.current;
      const result = await desktop?.finishRecording();
      const filename = result?.filePath?.split(/[\\/]/).pop();
      setRecordingNotice(filename ? `Recording saved: ${filename}` : "Recording saved.");
    } catch (error) {
      console.error("Could not finish the TeachIt recording.", error);
      await desktop?.cancelRecording().catch(() => undefined);
      setRecordingNotice("TeachIt couldn't save the recording. Check available disk space and try again.");
    } finally {
      recordingTracksRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      recordingTracksRef.current = [];
      recorderRef.current = null;
      recordingWriteRef.current = Promise.resolve();
      finalizingRecordingRef.current = false;
      setRecordingState("idle");
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setRecordingState("stopping");
    recorder.stop();
  };

  const startRecording = async () => {
    const desktop = getDesktopBridge();
    if (!desktop) {
      setRecordingNotice("Screen recording is available in the TeachIt Mac app.");
      return;
    }
    setRecordingNotice("");
    setRecordingState("starting");
    let fileReady = false;
    const acquiredStreams: MediaStream[] = [];
    try {
      // Start this permission request directly from the button gesture; Chromium
      // requires a fresh user activation for getDisplayMedia().
      const windowCapture = navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1200 },
          frameRate: { ideal: 24, max: 30 },
        },
        audio: false,
      });
      const windowStream = await windowCapture;
      acquiredStreams.push(windowStream);

      const microphoneStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      acquiredStreams.push(microphoneStream);

      const mimeType = [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4",
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) {
        throw new Error("MP4 recording isn't supported by this TeachIt build. No recording file was created.");
      }

      const destination = await desktop.startRecording(mimeType);
      if (destination.cancelled) {
        acquiredStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
        setRecordingState("idle");
        return;
      }
      if (destination.error) throw new Error(destination.error);
      fileReady = true;

      const combinedStream = new MediaStream([
        ...windowStream.getVideoTracks(),
        ...microphoneStream.getAudioTracks(),
      ]);
      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 2_500_000,
        audioBitsPerSecond: 96_000,
      });
      recordingTracksRef.current = acquiredStreams;
      recordingWriteRef.current = Promise.resolve();
      finalizingRecordingRef.current = false;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        recordingWriteRef.current = recordingWriteRef.current.then(async () => {
          await desktop.writeRecordingChunk(await event.data.arrayBuffer());
        });
        void recordingWriteRef.current.catch((error) => {
          console.error("Could not write the TeachIt recording chunk.", error);
          setRecordingNotice("Recording stopped because TeachIt couldn't write to the selected file.");
          if (recorder.state !== "inactive") recorder.stop();
        });
      };
      recorder.onerror = () => {
        setRecordingNotice("TeachIt encountered an error while recording.");
        if (recorder.state !== "inactive") recorder.stop();
      };
      recorder.onstop = () => { void finishRecording(); };
      windowStream.getVideoTracks()[0].addEventListener("ended", stopRecording, { once: true });
      recorder.start(1000);
      setRecordingState("recording");
    } catch (error) {
      acquiredStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      recordingTracksRef.current = [];
      recorderRef.current = null;
      if (fileReady) await desktop.cancelRecording().catch(() => undefined);
      setRecordingState("idle");
      setRecordingNotice(formatRecorderError(error));
    }
  };

  const mediaActions = (
    <>
      <button
        className="teachit-action-button"
        type="button"
        onClick={() => void toggleCamera()}
        title={cameraStream ? "Turn camera off" : "Turn camera on"}
      >
        {cameraStream ? "Camera Off" : "Camera On"}
      </button>
      {recordingState === "recording" || recordingState === "stopping" ? (
        <button className="teachit-action-button teachit-action-button--recording" type="button" onClick={stopRecording}>
          {recordingState === "stopping" ? "Saving…" : "Stop recording"}
        </button>
      ) : (
        <button
          className="teachit-action-button"
          type="button"
          disabled={recordingState === "starting"}
          onClick={() => void startRecording()}
          title="Record the TeachIt window and microphone to an MP4 file"
        >
          {recordingState === "starting" ? "Starting…" : "Record"}
        </button>
      )}
    </>
  );

  return (
    <main className="whiteboard">
      {canvasMode === "teachit" ? (
        <TeachItCanvas
          actions={(
            <div className="teachit-toolbar-actions">
              <button className="teachit-action-button" type="button" onClick={() => setCanvasMode("excalidraw")}>
                Back to Excalidraw preview
              </button>
              {mediaActions}
            </div>
          )}
        />
      ) : loaded ? (
        <Excalidraw
          initialData={initialData as never}
          excalidrawAPI={(api) => {
            apiRef.current = api;
            setApi(api);
          }}
          libraryReturnUrl={`${window.location.origin}${window.location.pathname}`}
          renderTopRightUI={() => (
            <div className="teachit-toolbar-actions">
              <button className="teachit-action-button" type="button" onClick={() => setCanvasMode("teachit")}>
                Try TeachIt Canvas
              </button>
              <ImportLibraryButton api={api} />
              {mediaActions}
            </div>
          )}
          onChange={(elements, appState, files) => {
            scheduleSave({
              elements,
              appState: {
                currentItemBackgroundColor: appState.currentItemBackgroundColor,
                currentItemFillStyle: appState.currentItemFillStyle,
                currentItemFontFamily: appState.currentItemFontFamily,
                currentItemFontSize: appState.currentItemFontSize,
                currentItemOpacity: appState.currentItemOpacity,
                currentItemRoughness: appState.currentItemRoughness,
                currentItemStrokeColor: appState.currentItemStrokeColor,
                currentItemStrokeStyle: appState.currentItemStrokeStyle,
                currentItemStrokeWidth: appState.currentItemStrokeWidth,
                currentItemTextAlign: appState.currentItemTextAlign,
                gridModeEnabled: appState.gridModeEnabled,
                gridSize: appState.gridSize,
                scrollX: appState.scrollX,
                scrollY: appState.scrollY,
                theme: appState.theme,
                viewBackgroundColor: appState.viewBackgroundColor,
                zoom: appState.zoom,
                zenModeEnabled: appState.zenModeEnabled,
              },
              files,
            });
          }}
        />
      ) : (
        <div className="loading" aria-label="Loading whiteboard">
          <span className="loading-mark" />
        </div>
      )}
      {cameraStream && <CameraPreview stream={cameraStream} />}
      {recordingNotice && <div className="teachit-recording-notice" role="status" aria-live="polite">{recordingNotice}</div>}
    </main>
  );
}

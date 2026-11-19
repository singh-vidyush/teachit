import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";

type Point = { x: number; y: number };
type Tool = "select" | "draw" | "rectangle" | "ellipse" | "line" | "arrow" | "text" | "erase" | "pan";
type ShapeKind = "rectangle" | "ellipse" | "line" | "arrow";
type ElementBase = { id: string; stroke: string; strokeWidth: number; fill?: string };
type PathElement = ElementBase & { type: "freehand"; points: Point[] };
type ShapeElement = ElementBase & { type: ShapeKind; x: number; y: number; width: number; height: number };
type TextElement = ElementBase & { type: "text"; x: number; y: number; text: string; fontSize: number };
type CanvasElement = PathElement | ShapeElement | TextElement;
type LibraryItem = { id: string; name: string; elements: CanvasElement[] };
type Camera = { x: number; y: number; zoom: number };
type TextDraft = { point: Point; screenX: number; screenY: number; editingId?: string };
type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Gesture = {
  kind: "draw" | "shape" | "move" | "pan" | "resize" | "erase" | "marquee";
  pointerId: number;
  start: Point;
  startScreen: Point;
  before?: CanvasElement[];
  ids?: string[];
  originalBounds?: ReturnType<typeof bounds>;
  handle?: ResizeHandle;
  additive?: boolean;
};
const RESIZE_HANDLES: { id: ResizeHandle; x: number; y: number; cursor: string }[] = [
  { id: "nw", x: 0, y: 0, cursor: "nwse-resize" },
  { id: "n", x: 0.5, y: 0, cursor: "ns-resize" },
  { id: "ne", x: 1, y: 0, cursor: "nesw-resize" },
  { id: "e", x: 1, y: 0.5, cursor: "ew-resize" },
  { id: "se", x: 1, y: 1, cursor: "nwse-resize" },
  { id: "s", x: 0.5, y: 1, cursor: "ns-resize" },
  { id: "sw", x: 0, y: 1, cursor: "nesw-resize" },
  { id: "w", x: 0, y: 0.5, cursor: "ew-resize" },
];

const DATABASE = "teachit-native-canvas";
const STORE = "documents";
const DOCUMENT_KEY = "main";
const COLORS = ["#252525", "#6f59d9", "#2387a5", "#d65050", "#2b9666"];
const FILLS = ["transparent", "#fff1b8", "#d8f5e7", "#e7e0ff", "#ffe0e0"];
const STROKE_WIDTHS = [2, 3.5, 5.5];
const TOOLS: { id: Tool; label: string; shortcut: string }[] = [
  { id: "select", label: "Select", shortcut: "V" },
  { id: "draw", label: "Draw", shortcut: "P" },
  { id: "rectangle", label: "Rectangle", shortcut: "R" },
  { id: "ellipse", label: "Ellipse", shortcut: "O" },
  { id: "line", label: "Line", shortcut: "L" },
  { id: "arrow", label: "Arrow", shortcut: "A" },
  { id: "text", label: "Text", shortcut: "T" },
  { id: "erase", label: "Eraser", shortcut: "E" },
  { id: "pan", label: "Hand", shortcut: "H" },
];

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function loadDocument(): Promise<{ elements: CanvasElement[]; camera: Camera; libraries?: LibraryItem[] } | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(DOCUMENT_KEY);
    request.onsuccess = () => resolve(request.result as { elements: CanvasElement[]; camera: Camera } | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function saveDocument(value: { elements: CanvasElement[]; camera: Camera; libraries?: LibraryItem[] }) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(value, DOCUMENT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function randomFor(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function seedFromId(id: string) {
  let seed = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    seed = Math.imul(seed ^ id.charCodeAt(index), 16777619);
  }
  return seed >>> 0;
}

function curveThrough(points: Point[], close = false) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} l 0.1 0`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}${close ? " Z" : ""}`;
  }
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const middle = { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 };
    path += ` Q ${current.x} ${current.y} ${middle.x} ${middle.y}`;
  }
  const last = points[points.length - 1];
  path += ` T ${last.x} ${last.y}${close ? " Z" : ""}`;
  return path;
}

function roughSegment(start: Point, end: Point, seed: number, amplitude = 0.9) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.ceil(distance / 10));
  const normal = distance ? { x: -dy / distance, y: dx / distance } : { x: 0, y: 1 };
  const random = randomFor(seed);
  const points = [start];
  for (let index = 1; index < steps; index += 1) {
    const amount = index / steps;
    const fade = Math.sin(Math.PI * amount);
    const offset = (random() * 2 - 1) * amplitude * fade;
    points.push({
      x: start.x + dx * amount + normal.x * offset,
      y: start.y + dy * amount + normal.y * offset,
    });
  }
  points.push(end);
  return points;
}

function roughPolyline(points: Point[], seed: number, close = false, amplitude = 0.9) {
  if (points.length < 2) return curveThrough(points, close);
  const result: Point[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const segment = roughSegment(points[index], points[index + 1], seed + index * 991, amplitude);
    result.push(...(index === 0 ? segment : segment.slice(1)));
  }
  if (close) {
    const segment = roughSegment(points[points.length - 1], points[0], seed + 8761, amplitude);
    result.push(...segment.slice(1, -1));
  }
  return curveThrough(result, close);
}

function elementPath(element: PathElement | ShapeElement, secondary = false) {
  const seed = seedFromId(element.id);
  const offset = secondary ? 1.25 : 0;
  if (element.type === "freehand") {
    const points = element.points.map((point, index) => ({
      x: point.x + offset * Math.sin(seed + index * 1.71),
      y: point.y + offset * Math.cos(seed + index * 1.37),
    }));
    return curveThrough(points);
  }
  if (element.type === "rectangle") {
    const { x, y, width, height } = element;
    const points = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
    return roughPolyline(points, seed + (secondary ? 53 : 0), true, secondary ? 1.45 : 0.75);
  }
  if (element.type === "ellipse") {
    const { x, y, width, height } = element;
    const random = randomFor(seed + (secondary ? 93 : 0));
    const points = Array.from({ length: 56 }, (_, index) => {
      const angle = (index / 56) * Math.PI * 2;
      const jitter = (random() - 0.5) * (secondary ? 2.8 : 1.6);
      return {
        x: x + width / 2 + Math.cos(angle) * (width / 2 + jitter),
        y: y + height / 2 + Math.sin(angle) * (height / 2 + jitter),
      };
    });
    return curveThrough(points, true);
  }
  const { x, y, width, height } = element;
  const start = { x, y };
  const end = { x: x + width, y: y + height };
  const main = roughPolyline([start, end], seed + (secondary ? 53 : 0), false, secondary ? 1.45 : 0.65);
  if (element.type !== "arrow") return main;
  const angle = Math.atan2(height, width);
  const size = Math.min(17, Math.max(8, Math.hypot(width, height) * 0.22));
  const left = { x: end.x - size * Math.cos(angle - Math.PI / 6), y: end.y - size * Math.sin(angle - Math.PI / 6) };
  const right = { x: end.x - size * Math.cos(angle + Math.PI / 6), y: end.y - size * Math.sin(angle + Math.PI / 6) };
  return `${main} ${roughPolyline([left, end, right], seed + 7821 + (secondary ? 59 : 0), false, secondary ? 1.45 : 0.65)}`;
}

function bounds(element: CanvasElement) {
  if (element.type === "text") {
    const lines = element.text.split("\n");
    return {
      x: element.x,
      y: element.y,
      width: Math.max(24, ...lines.map((line) => line.length * element.fontSize * 0.61)),
      height: Math.max(1, lines.length) * element.fontSize * 1.2,
    };
  }
  if (element.type === "freehand") {
    const xs = element.points.map((point) => point.x);
    const ys = element.points.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    };
  }
  return {
    x: Math.min(element.x, element.x + element.width),
    y: Math.min(element.y, element.y + element.height),
    width: Math.max(1, Math.abs(element.width)),
    height: Math.max(1, Math.abs(element.height)),
  };
}

function combinedBounds(elements: CanvasElement[]) {
  if (elements.length === 0) return null;
  const boxes = elements.map(bounds);
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function translate(element: CanvasElement, dx: number, dy: number): CanvasElement {
  if (element.type === "freehand") {
    return { ...element, points: element.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
  }
  return { ...element, x: element.x + dx, y: element.y + dy };
}

function resizeElement(element: CanvasElement, original: ReturnType<typeof bounds>, next: ReturnType<typeof bounds>) {
  const sx = next.width / Math.max(1, original.width);
  const sy = next.height / Math.max(1, original.height);
  const mapPoint = (point: Point) => ({
    x: next.x + (point.x - original.x) * sx,
    y: next.y + (point.y - original.y) * sy,
  });
  if (element.type === "freehand") return { ...element, points: element.points.map(mapPoint) };
  if (element.type === "text") {
    return {
      ...element,
      ...mapPoint({ x: element.x, y: element.y }),
      fontSize: Math.max(10, element.fontSize * Math.sqrt(Math.abs(sx * sy))),
    };
  }
  const start = mapPoint({ x: element.x, y: element.y });
  const end = mapPoint({ x: element.x + element.width, y: element.y + element.height });
  return { ...element, x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
}

function boxesOverlap(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>, padding = 0) {
  return a.x - padding <= b.x + b.width && a.x + a.width + padding >= b.x &&
    a.y - padding <= b.y + b.height && a.y + a.height + padding >= b.y;
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
}

function hitTest(element: CanvasElement, point: Point, radius: number) {
  const threshold = radius + element.strokeWidth / 2;
  if (element.type === "text") {
    const box = bounds(element);
    return point.x >= box.x - radius && point.x <= box.x + box.width + radius &&
      point.y >= box.y - radius && point.y <= box.y + box.height + radius;
  }
  if (element.type === "freehand") {
    return element.points.some((current, index) => index > 0 && distanceToSegment(point, element.points[index - 1], current) <= threshold);
  }
  if (element.type === "line" || element.type === "arrow") {
    const start = { x: element.x, y: element.y };
    const end = { x: element.x + element.width, y: element.y + element.height };
    if (distanceToSegment(point, start, end) <= threshold) return true;
    if (element.type === "arrow") {
      const angle = Math.atan2(element.height, element.width);
      const size = Math.min(17, Math.max(8, Math.hypot(element.width, element.height) * 0.22));
      const left = { x: end.x - size * Math.cos(angle - Math.PI / 6), y: end.y - size * Math.sin(angle - Math.PI / 6) };
      const right = { x: end.x - size * Math.cos(angle + Math.PI / 6), y: end.y - size * Math.sin(angle + Math.PI / 6) };
      return distanceToSegment(point, left, end) <= threshold || distanceToSegment(point, end, right) <= threshold;
    }
    return false;
  }
  const box = bounds(element);
  if (element.fill && element.fill !== "transparent" &&
    point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) return true;
  if (element.type === "rectangle") {
    const corners = [
      { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height },
    ];
    return corners.some((corner, index) => distanceToSegment(point, corner, corners[(index + 1) % corners.length]) <= threshold);
  }
  const rx = Math.max(1, box.width / 2);
  const ry = Math.max(1, box.height / 2);
  const normalized = Math.sqrt(((point.x - (box.x + rx)) / rx) ** 2 + ((point.y - (box.y + ry)) / ry) ** 2);
  return Math.abs(normalized - 1) * Math.min(rx, ry) <= threshold;
}

function resizedBounds(original: ReturnType<typeof bounds>, handle: ResizeHandle, point: Point) {
  let left = original.x;
  let right = original.x + original.width;
  let top = original.y;
  let bottom = original.y + original.height;
  if (handle.includes("w")) left = Math.min(point.x, right - 8);
  if (handle.includes("e")) right = Math.max(point.x, left + 8);
  if (handle.includes("n")) top = Math.min(point.y, bottom - 8);
  if (handle.includes("s")) bottom = Math.max(point.y, top + 8);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function ElementView({ element }: {
  element: CanvasElement;
}) {
  const hitProps = {
    "data-canvas-id": element.id,
  };
  const hitStyle = { cursor: "move", pointerEvents: "all" as const };
  return (
    <g>
      {element.type === "text" ? (
        <text
          {...hitProps}
          x={element.x}
          y={element.y + element.fontSize}
          fill={element.stroke}
          fontSize={element.fontSize}
          fontFamily="Chalkboard SE, Comic Sans MS, cursive"
          style={hitStyle}
        >
          {element.text.split("\n").map((line, index) => (
            <tspan key={`${element.id}-${index}`} x={element.x} dy={index === 0 ? 0 : element.fontSize * 1.2}>{line || " "}</tspan>
          ))}
        </text>
      ) : (
        <>
          <path
            d={elementPath(element, true)}
            fill="none"
            stroke={element.stroke}
            strokeWidth={element.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.24}
            pointerEvents="none"
          />
          <path
            {...hitProps}
            d={elementPath(element)}
            fill={element.type === "rectangle" || element.type === "ellipse" ? (element.fill ?? "transparent") : "none"}
            stroke={element.stroke}
            strokeWidth={element.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={hitStyle}
          />
        </>
      )}
    </g>
  );
}

function ToolbarButton({ active, disabled, label, shortcut, onClick, children }: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`native-tool${active ? " is-active" : ""}`}
      disabled={disabled}
      aria-label={`${label}${shortcut ? ` (${shortcut})` : ""}`}
      aria-pressed={active ?? false}
      title={`${label}${shortcut ? ` · ${shortcut}` : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function TeachItCanvas({ actions }: { actions: React.ReactNode }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const elementsRef = useRef<CanvasElement[]>([]);
  const undoRef = useRef<CanvasElement[][]>([]);
  const redoRef = useRef<CanvasElement[][]>([]);
  const gestureRef = useRef<Gesture | null>(null);
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [libraries, setLibraries] = useState<LibraryItem[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [stroke, setStroke] = useState(COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(STROKE_WIDTHS[0]);
  const [fill, setFill] = useState(FILLS[0]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<CanvasElement | null>(null);
  const [marquee, setMarquee] = useState<ReturnType<typeof bounds> | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [loaded, setLoaded] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [textValue, setTextValue] = useState("");
  const [spaceDown, setSpaceDown] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void loadDocument().then((document) => {
      if (!active) return;
      const restored = document?.elements ?? [];
      elementsRef.current = restored;
      setElements(restored);
      setLibraries(document?.libraries ?? []);
      if (document?.camera) setCamera(document.camera);
      setLoaded(true);
    }).catch((error) => {
      console.error("Could not load the TeachIt canvas.", error);
      if (active) setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      void saveDocument({ elements, camera, libraries }).then(() => {
        setSaveNotice("Saved on this Mac");
        window.setTimeout(() => setSaveNotice(""), 1800);
      }).catch((error) => {
        console.error("Could not save the TeachIt canvas.", error);
        setSaveNotice("Couldn't save canvas");
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [elements, camera, libraries, loaded]);

  const parseLibraryFiles = useCallback(async (files: FileList | File[]) => {
    const imported: LibraryItem[] = [];
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".excalidrawlib")) continue;
      try {
        const data = JSON.parse(await file.text()) as { libraryItems?: Array<{ id?: string; name?: string; elements?: Array<Record<string, unknown>> }> };
        if (!Array.isArray(data.libraryItems)) throw new Error("Missing libraryItems");
        for (const item of data.libraryItems) {
          const converted: CanvasElement[] = [];
          for (const raw of item.elements ?? []) {
            const id = randomId();
            const x = Number(raw.x ?? 0); const y = Number(raw.y ?? 0);
            const width = Number(raw.width ?? 0); const height = Number(raw.height ?? 0);
            const stroke = typeof raw.strokeColor === "string" ? raw.strokeColor : COLORS[0];
            const strokeWidth = Number(raw.strokeWidth ?? 2);
            const type = raw.type;
            if (type === "text" && typeof raw.text === "string") {
              converted.push({ id, type, x, y, text: raw.text, stroke, strokeWidth, fontSize: Number(raw.fontSize ?? 24) });
            } else if (["rectangle", "ellipse", "line", "arrow"].includes(String(type))) {
              const fill = typeof raw.backgroundColor === "string" && raw.backgroundColor !== "transparent" ? raw.backgroundColor : "transparent";
              converted.push({ id, type: type as ShapeKind, x, y, width, height, stroke, strokeWidth, fill });
            } else if (["freedraw", "draw"].includes(String(type)) && Array.isArray(raw.points)) {
              const points = (raw.points as unknown[]).flatMap((point) => Array.isArray(point) && point.length >= 2
                ? [{ x: x + Number(point[0]), y: y + Number(point[1]) }] : []);
              if (points.length) converted.push({ id, type: "freehand", points, stroke, strokeWidth });
            }
          }
          if (converted.length) imported.push({ id: randomId(), name: item.name || file.name.replace(/\.excalidrawlib$/i, ""), elements: converted });
        }
      } catch {
        failures.push(file.name);
      }
    }
    if (imported.length) {
      setLibraries((current) => [...current, ...imported]);
      setSaveNotice(`Added ${imported.length} library item${imported.length === 1 ? "" : "s"}`);
    }
    if (failures.length) setSaveNotice(`Couldn't read ${failures.join(", ")}`);
    setLibraryOpen(true);
  }, []);

  const saveSelectionToLibrary = () => {
    const selected = new Set(selectedIds);
    const chosen = elementsRef.current.filter((element) => selected.has(element.id));
    if (!chosen.length) return;
    const name = window.prompt("Name this library item");
    if (!name?.trim()) return;
    const box = combinedBounds(chosen);
    if (!box) return;
    setLibraries((current) => [...current, {
      id: randomId(), name: name.trim(),
      elements: chosen.map((element) => translate(element, -box.x, -box.y)),
    }]);
    setLibraryOpen(true);
  };

  const setCurrentElements = useCallback((next: CanvasElement[]) => {
    elementsRef.current = next;
    setElements(next);
  }, []);

  const commit = useCallback((next: CanvasElement[], previous = elementsRef.current) => {
    undoRef.current = [...undoRef.current, previous].slice(-100);
    redoRef.current = [];
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(false);
    setCurrentElements(next);
  }, [setCurrentElements]);

  const insertLibraryItem = useCallback((item: LibraryItem) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || item.elements.length === 0) return;
    const center = { x: (rect.width / 2 - camera.x) / camera.zoom, y: (rect.height / 2 - camera.y) / camera.zoom };
    const box = combinedBounds(item.elements);
    if (!box) return;
    const offsetX = center.x - box.x - box.width / 2;
    const offsetY = center.y - box.y - box.height / 2;
    const added = item.elements.map((element) => ({ ...translate(element, offsetX, offsetY), id: randomId() }));
    commit([...elementsRef.current, ...added]);
    setSelectedIds(added.map((element) => element.id));
    setLibraryOpen(false);
  }, [camera, commit]);

  const updateSelectedElements = useCallback((update: (element: CanvasElement) => CanvasElement) => {
    if (selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    const next = elementsRef.current.map((element) => selected.has(element.id) ? update(element) : element);
    commit(next);
  }, [commit, selectedIds]);

  const duplicateSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    const copies = elementsRef.current.filter((element) => selected.has(element.id)).map((element) => ({
      ...translate(element, 18, 18),
      id: randomId(),
    }));
    commit([...elementsRef.current, ...copies]);
    setSelectedIds(copies.map((element) => element.id));
  }, [commit, selectedIds]);

  const deleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    commit(elementsRef.current.filter((element) => !selected.has(element.id)));
    setSelectedIds([]);
  }, [commit, selectedIds]);

  const chooseStroke = (color: string) => {
    setStroke(color);
    updateSelectedElements((element) => ({ ...element, stroke: color }));
  };

  const chooseStrokeWidth = (width: number) => {
    setStrokeWidth(width);
    updateSelectedElements((element) => ({ ...element, strokeWidth: width }));
  };

  const chooseFill = (color: string) => {
    setFill(color);
    if (!selectedIds.some((id) => elementsRef.current.some((element) => element.id === id && (element.type === "rectangle" || element.type === "ellipse")))) return;
    updateSelectedElements((element) => element.type === "rectangle" || element.type === "ellipse" ? { ...element, fill: color } : element);
  };

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(elementsRef.current);
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(true);
    setCurrentElements(previous);
    setSelectedIds([]);
  }, [setCurrentElements]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(elementsRef.current);
    setCanUndo(true);
    setCanRedo(redoRef.current.length > 0);
    setCurrentElements(next);
    setSelectedIds([]);
  }, [setCurrentElements]);

  const toWorld = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left - camera.x) / camera.zoom,
      y: (event.clientY - rect.top - camera.y) / camera.zoom,
    };
  }, [camera]);

  const startText = (event: ReactPointerEvent<SVGSVGElement>, point: Point, editing?: TextElement) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTextValue(editing?.text ?? "");
    setTextDraft({ point, screenX: event.clientX - rect.left, screenY: event.clientY - rect.top, editingId: editing?.id });
  };

  const commitText = () => {
    if (!textDraft || !textValue.trim()) {
      if (textDraft?.editingId) {
        commit(elementsRef.current.filter((element) => element.id !== textDraft.editingId));
        setSelectedIds([]);
      }
      setTextDraft(null);
      return;
    }
    if (textDraft.editingId) {
      const next = elementsRef.current.map((element) => element.id === textDraft.editingId && element.type === "text"
        ? { ...element, text: textValue.trim() }
        : element);
      commit(next);
      setSelectedIds([textDraft.editingId]);
      setTextDraft(null);
      return;
    }
    const next: TextElement = {
      id: randomId(), type: "text", x: textDraft.point.x, y: textDraft.point.y,
      text: textValue.trim(), stroke, strokeWidth, fontSize: 24,
    };
    commit([...elementsRef.current, next]);
    setSelectedIds([next.id]);
    setTextDraft(null);
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const world = toWorld(event);
    const screen = { x: event.clientX, y: event.clientY };
    const target = event.target as Element;
    const hitId = target.closest("[data-canvas-id]")?.getAttribute("data-canvas-id") ?? null;
    const resizeHandle = target.closest("[data-resize-handle]")?.getAttribute("data-resize-handle") as ResizeHandle | null;
    const moving = event.button === 1 || tool === "pan" || spaceDown;
    event.currentTarget.setPointerCapture(event.pointerId);

    if (moving) {
      gestureRef.current = { kind: "pan", pointerId: event.pointerId, start: world, startScreen: screen };
      return;
    }
    if (tool === "select") {
      if (resizeHandle && selectedIds.length > 0) {
        const chosen = elementsRef.current.filter((element) => selectedIds.includes(element.id));
        const originalBounds = combinedBounds(chosen);
        if (originalBounds) {
          gestureRef.current = {
            kind: "resize", pointerId: event.pointerId, start: world, startScreen: screen,
            before: elementsRef.current, ids: selectedIds, originalBounds, handle: resizeHandle,
          };
        }
        return;
      }
      if (hitId) {
        const initial = elementsRef.current.find((element) => element.id === hitId);
        if (event.detail >= 2 && initial?.type === "text") {
          setSelectedIds([hitId]);
          startText(event, { x: initial.x, y: initial.y }, initial);
          return;
        }
        if (event.shiftKey && selectedIds.includes(hitId)) {
          setSelectedIds(selectedIds.filter((id) => id !== hitId));
          return;
        }
        const ids = event.shiftKey ? [...new Set([...selectedIds, hitId])] : selectedIds.includes(hitId) ? selectedIds : [hitId];
        setSelectedIds(ids);
        if (initial) {
          gestureRef.current = {
            kind: "move", pointerId: event.pointerId, start: world, startScreen: screen,
            ids, before: elementsRef.current,
          };
        }
      } else {
        if (!event.shiftKey) setSelectedIds([]);
        gestureRef.current = {
          kind: "marquee", pointerId: event.pointerId, start: world, startScreen: screen,
          ids: selectedIds, additive: event.shiftKey,
        };
        setMarquee({ x: world.x, y: world.y, width: 0, height: 0 });
      }
      return;
    }
    if (tool === "text") {
      startText(event, world);
      return;
    }
    if (tool === "erase") {
      const gesture: Gesture = { kind: "erase", pointerId: event.pointerId, start: world, startScreen: screen, before: elementsRef.current, ids: [] };
      gestureRef.current = gesture;
      const radius = 16 / camera.zoom;
      const erased = (gesture.before ?? []).filter((element) => hitTest(element, world, radius));
      gesture.ids = erased.map((element) => element.id);
      if (gesture.ids.length > 0) {
        setCurrentElements((gesture.before ?? []).filter((element) => !gesture.ids?.includes(element.id)));
        setSelectedIds(selectedIds.filter((id) => !gesture.ids?.includes(id)));
      }
      return;
    }
    const id = randomId();
    if (tool === "draw") {
      const next: PathElement = { id, type: "freehand", points: [world], stroke, strokeWidth };
      gestureRef.current = { kind: "draw", pointerId: event.pointerId, start: world, startScreen: screen };
      setDraft(next);
      return;
    }
    if (["rectangle", "ellipse", "line", "arrow"].includes(tool)) {
      const next: ShapeElement = {
        id, type: tool as ShapeKind, x: world.x, y: world.y, width: 0, height: 0,
        stroke, strokeWidth, fill,
      };
      gestureRef.current = { kind: "shape", pointerId: event.pointerId, start: world, startScreen: screen };
      setDraft(next);
    }
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "pan") {
      setCamera((current) => ({
        ...current,
        x: current.x + event.clientX - gesture.startScreen.x,
        y: current.y + event.clientY - gesture.startScreen.y,
      }));
      gesture.startScreen = { x: event.clientX, y: event.clientY };
      return;
    }
    const world = toWorld(event);
    if (gesture.kind === "move" && gesture.before && gesture.ids) {
      const dx = world.x - gesture.start.x;
      const dy = world.y - gesture.start.y;
      const ids = new Set(gesture.ids);
      const next = gesture.before.map((element) => ids.has(element.id) ? translate(element, dx, dy) : element);
      setCurrentElements(next);
      return;
    }
    if (gesture.kind === "resize" && gesture.before && gesture.ids && gesture.originalBounds && gesture.handle) {
      const nextBounds = resizedBounds(gesture.originalBounds, gesture.handle, world);
      const ids = new Set(gesture.ids);
      setCurrentElements(gesture.before.map((element) => ids.has(element.id)
        ? resizeElement(element, gesture.originalBounds!, nextBounds)
        : element));
      return;
    }
    if (gesture.kind === "erase" && gesture.before && gesture.ids) {
      const radius = 16 / camera.zoom;
      const touched = gesture.before.filter((element) => hitTest(element, world, radius)).map((element) => element.id);
      gesture.ids = [...new Set([...gesture.ids, ...touched])];
      const erased = new Set(gesture.ids);
      setCurrentElements(gesture.before.filter((element) => !erased.has(element.id)));
      setSelectedIds((current) => current.filter((id) => !erased.has(id)));
      return;
    }
    if (gesture.kind === "marquee") {
      const left = Math.min(gesture.start.x, world.x);
      const top = Math.min(gesture.start.y, world.y);
      setMarquee({ x: left, y: top, width: Math.abs(world.x - gesture.start.x), height: Math.abs(world.y - gesture.start.y) });
      return;
    }
    setDraft((current) => {
      if (!current) return current;
      if (current.type === "freehand") {
        const last = current.points[current.points.length - 1];
        if (Math.hypot(world.x - last.x, world.y - last.y) < 1.5 / camera.zoom) return current;
        return { ...current, points: [...current.points, world] };
      }
      if (current.type === "text") return current;
      return { ...current, width: world.x - gesture.start.x, height: world.y - gesture.start.y };
    });
  };

  const onCanvasPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "move" || gesture.kind === "resize" || gesture.kind === "erase") {
      const moved = Math.hypot(event.clientX - gesture.startScreen.x, event.clientY - gesture.startScreen.y) > 2;
      const changed = gesture.kind === "erase" ? (gesture.ids?.length ?? 0) > 0 : moved;
      if (changed && gesture.before) {
        undoRef.current = [...undoRef.current, gesture.before].slice(-100);
        redoRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
      }
    } else if (gesture.kind === "marquee") {
      const end = toWorld(event);
      const selectionBox = {
        x: Math.min(gesture.start.x, end.x), y: Math.min(gesture.start.y, end.y),
        width: Math.abs(end.x - gesture.start.x), height: Math.abs(end.y - gesture.start.y),
      };
      const found = elementsRef.current.filter((element) => boxesOverlap(bounds(element), selectionBox)).map((element) => element.id);
      setSelectedIds(gesture.additive ? [...new Set([...(gesture.ids ?? []), ...found])] : found);
      setMarquee(null);
    } else if (gesture.kind === "draw" || gesture.kind === "shape") {
      const completed = draft;
      const moved = Math.hypot(event.clientX - gesture.startScreen.x, event.clientY - gesture.startScreen.y) > 2;
      if (completed && moved) {
        commit([...elementsRef.current, completed]);
        setSelectedIds([completed.id]);
      }
      setDraft(null);
    }
    gestureRef.current = null;
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (!event.metaKey && !event.ctrlKey) {
      setCamera((current) => ({
        ...current,
        x: current.x - event.deltaX - (event.shiftKey ? event.deltaY : 0),
        y: current.y - (event.shiftKey ? 0 : event.deltaY),
      }));
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0012);
    setCamera((current) => {
      const zoom = Math.min(16, Math.max(0.05, current.zoom * factor));
      const worldX = (sx - current.x) / current.zoom;
      const worldY = (sy - current.y) / current.zoom;
      return { x: sx - worldX * zoom, y: sy - worldY * zoom, zoom };
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") return;
      if (event.code === "Space") { event.preventDefault(); setSpaceDown(true); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSelected(); return; }
      if (event.key === "Backspace" || event.key === "Delete") {
        deleteSelected();
        return;
      }
      if (event.key === "Escape") { setSelectedIds([]); setDraft(null); setTextDraft(null); setMarquee(null); return; }
      const shortcut = TOOLS.find((item) => item.shortcut.toLowerCase() === event.key.toLowerCase());
      if (shortcut) setTool(shortcut.id);
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === "Space") setSpaceDown(false); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [deleteSelected, duplicateSelected, redo, undo]);

  const zoomBy = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const sx = rect ? rect.width / 2 : 0;
    const sy = rect ? rect.height / 2 : 0;
    setCamera((current) => {
      const zoom = Math.min(16, Math.max(0.05, current.zoom * factor));
      const worldX = (sx - current.x) / current.zoom;
      const worldY = (sy - current.y) / current.zoom;
      return { x: sx - worldX * zoom, y: sy - worldY * zoom, zoom };
    });
  };

  const drawnElements = draft ? [...elements, draft] : elements;
  const textStyle: CSSProperties = textDraft ? { left: textDraft.screenX + 4, top: textDraft.screenY + 4 } : {};
  const selectionBox = combinedBounds(elements.filter((element) => selectedIds.includes(element.id)));
  const cursorClass = tool === "draw" ? "cursor-draw" : tool === "text" ? "cursor-text" : tool === "erase" ? "cursor-erase" : tool === "pan" || spaceDown ? "cursor-pan" : "";

  return (
    <main className="native-whiteboard">
      <header className="native-header">
        <div className="native-brand"><span className="native-brand-mark">t</span><span>TeachIt Canvas <small>PREVIEW</small></span></div>
        <div className="native-toolbar" role="toolbar" aria-label="Whiteboard tools">
          {TOOLS.map((item) => (
            <ToolbarButton key={item.id} active={tool === item.id} label={item.label} shortcut={item.shortcut} onClick={() => setTool(item.id)}>
              <ToolGlyph tool={item.id} />
            </ToolbarButton>
          ))}
          <span className="native-divider" />
          <ToolbarButton disabled={!canUndo} label="Undo" shortcut="⌘Z" onClick={undo}>{"↶"}</ToolbarButton>
          <ToolbarButton disabled={!canRedo} label="Redo" shortcut="⌘⇧Z" onClick={redo}>{"↷"}</ToolbarButton>
        </div>
        <div className="native-actions">{actions}</div>
      </header>
      <div
        className={`native-canvas-shell ${cursorClass}`}
        style={{
          backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
          backgroundPosition: `${camera.x % (24 * camera.zoom)}px ${camera.y % (24 * camera.zoom)}px`,
        }}
        onDragOver={(event) => { event.preventDefault(); }}
        onDrop={(event) => {
          event.preventDefault();
          void parseLibraryFiles(event.dataTransfer.files);
        }}
      >
        <button type="button" className={`native-library-toggle${libraryOpen ? " is-active" : ""}`} onClick={() => setLibraryOpen((open) => !open)} aria-expanded={libraryOpen}>
          <span aria-hidden="true">▧</span> Library
        </button>
        <input
          ref={libraryInputRef}
          type="file"
          accept=".excalidrawlib,application/json"
          multiple
          hidden
          onChange={(event) => { if (event.target.files) void parseLibraryFiles(event.target.files); event.target.value = ""; }}
        />
        {libraryOpen && (
          <aside className="native-library-drawer" aria-label="TeachIt library">
            <header><div><strong>Library</strong><small>Saved shapes and diagrams</small></div><button type="button" aria-label="Close library" onClick={() => setLibraryOpen(false)}>×</button></header>
            <div className="native-library-actions">
              <button type="button" onClick={() => libraryInputRef.current?.click()}>Import .excalidrawlib</button>
              <button type="button" disabled={selectedIds.length === 0} onClick={saveSelectionToLibrary}>Save selection</button>
            </div>
            <div className="native-library-list">
              {libraries.length === 0 ? <p>Drop downloaded .excalidrawlib files here or import one to get started.</p> : libraries.map((item) => (
                <div className="native-library-item" key={item.id}>
                  <button type="button" className="native-library-preview" aria-label={`Add ${item.name} to canvas`} onClick={() => insertLibraryItem(item)}>
                    <svg
                      viewBox={(() => {
                        const box = combinedBounds(item.elements) ?? { x: 0, y: 0, width: 1, height: 1 };
                        return `${box.x - 6} ${box.y - 6} ${Math.max(12, box.width + 12)} ${Math.max(12, box.height + 12)}`;
                      })()}
                      aria-hidden="true"
                    >
                      {item.elements.map((element) => <ElementView key={element.id} element={element} />)}
                    </svg>
                    <span>{item.name}</span>
                  </button>
                  <button type="button" className="native-library-delete" aria-label={`Remove ${item.name} from library`} onClick={() => setLibraries((current) => current.filter((candidate) => candidate.id !== item.id))}>×</button>
                </div>
              ))}
            </div>
          </aside>
        )}
        <div className="native-palette">
          <div className="native-property-group" role="group" aria-label="Stroke color">
            <span>Stroke</span>
            <div className="native-property-options">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`native-color${stroke === color ? " is-active" : ""}`}
                  style={{ backgroundColor: color }}
                  aria-label={`Use ${color} stroke`}
                  aria-pressed={stroke === color}
                  onClick={() => chooseStroke(color)}
                />
              ))}
            </div>
          </div>
          <div className="native-property-group" role="group" aria-label="Stroke width">
            <span>Width</span>
            <div className="native-property-options">
              {STROKE_WIDTHS.map((width) => (
                <button
                  key={width}
                  type="button"
                  className={`native-width${strokeWidth === width ? " is-active" : ""}`}
                  aria-label={`Stroke width ${width}`}
                  aria-pressed={strokeWidth === width}
                  onClick={() => chooseStrokeWidth(width)}
                ><span style={{ height: Math.max(2, width) }} /></button>
              ))}
            </div>
          </div>
          <div className="native-property-group" role="group" aria-label="Shape fill">
            <span>Fill</span>
            <div className="native-property-options">
              {FILLS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`native-fill${fill === color ? " is-active" : ""}${color === "transparent" ? " is-transparent" : ""}`}
                  style={{ backgroundColor: color === "transparent" ? "#fff" : color }}
                  aria-label={color === "transparent" ? "No fill" : `Use ${color} fill`}
                  aria-pressed={fill === color}
                  onClick={() => chooseFill(color)}
                />
              ))}
            </div>
          </div>
        </div>
        <svg
          ref={svgRef}
          className="native-canvas"
          aria-label="TeachIt drawing canvas"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
          onWheel={onWheel}
        >
          <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
            {drawnElements.map((element) => (
              <ElementView
                key={element.id}
                element={element}
              />
            ))}
            {selectionBox && (
              <g className="native-selection-box">
                <rect
                  x={selectionBox.x - 5}
                  y={selectionBox.y - 5}
                  width={selectionBox.width + 10}
                  height={selectionBox.height + 10}
                  rx={3}
                  fill="none"
                  stroke="#715ed5"
                  strokeWidth={1.2}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
                {RESIZE_HANDLES.map((handle) => (
                  <circle
                    key={handle.id}
                    data-resize-handle={handle.id}
                    cx={selectionBox.x + selectionBox.width * handle.x}
                    cy={selectionBox.y + selectionBox.height * handle.y}
                    r={5 / camera.zoom}
                    fill="#fff"
                    stroke="#715ed5"
                    strokeWidth={1.4 / camera.zoom}
                    style={{ cursor: handle.cursor, pointerEvents: "all" }}
                  />
                ))}
              </g>
            )}
            {marquee && (
              <rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.width}
                height={marquee.height}
                fill="rgb(111 89 217 / 10%)"
                stroke="#715ed5"
                strokeWidth={1 / camera.zoom}
                strokeDasharray={`${4 / camera.zoom} ${4 / camera.zoom}`}
                pointerEvents="none"
              />
            )}
          </g>
          <rect className="native-canvas-hit-area" x="0" y="0" width="100%" height="100%" fill="transparent" pointerEvents="none" />
        </svg>
        {textDraft && (
          <textarea
            className="native-text-editor"
            style={textStyle}
            value={textValue}
            aria-label="Type text for the canvas"
            placeholder="Type something…"
            autoFocus
            onChange={(event) => setTextValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commitText(); }
              if (event.key === "Escape") setTextDraft(null);
            }}
            onBlur={commitText}
          />
        )}
        {!loaded && <div className="native-loading">Opening your canvas…</div>}
        {loaded && elements.length === 0 && <div className="native-empty-hint">Choose a tool and start sketching</div>}
        <div className="native-zoom-controls" aria-label="Canvas zoom controls">
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(0.85)}>−</button>
          <span>{Math.round(camera.zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.18)}>+</button>
          <button type="button" className="native-reset-zoom" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>Reset</button>
        </div>
        <div className="native-save-status" role="status">{saveNotice}</div>
      </div>
    </main>
  );
}

function ToolGlyph({ tool }: { tool: Tool }) {
  switch (tool) {
    case "select": return <svg viewBox="0 0 24 24"><path d="M6 3l12 10-6 .7-2.7 6.1L6 3Z" /></svg>;
    case "draw": return <svg viewBox="0 0 24 24"><path d="M4 18c5-10 7 5 16-11" /></svg>;
    case "rectangle": return <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="1" /></svg>;
    case "ellipse": return <svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8" ry="7" /></svg>;
    case "line": return <svg viewBox="0 0 24 24"><path d="M5 18 19 6" /></svg>;
    case "arrow": return <svg viewBox="0 0 24 24"><path d="M4 18 19 6m-7 0h7v7" /></svg>;
    case "text": return <svg viewBox="0 0 24 24"><path d="M4 6h16M12 6v13m-4 0h8" /></svg>;
    case "erase": return <svg viewBox="0 0 24 24"><path d="m6 15 8-9a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-8 9H8l-4-4a2 2 0 0 1 0-3l2-2Z" /><path d="m8 11 8 8" /></svg>;
    case "pan": return <svg viewBox="0 0 24 24"><path d="M8 11V5a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v6c0 4-2 7-6 7h-2c-2 0-3-1-4-2l-4-4a1.5 1.5 0 0 1 2-2l3 2" /></svg>;
  }
}

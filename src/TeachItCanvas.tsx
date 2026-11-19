import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";

type Point = { x: number; y: number };
type Tool = "select" | "draw" | "rectangle" | "ellipse" | "line" | "arrow" | "text" | "pan";
type ShapeKind = "rectangle" | "ellipse" | "line" | "arrow";
type ElementBase = { id: string; stroke: string; strokeWidth: number };
type PathElement = ElementBase & { type: "freehand"; points: Point[] };
type ShapeElement = ElementBase & { type: ShapeKind; x: number; y: number; width: number; height: number };
type TextElement = ElementBase & { type: "text"; x: number; y: number; text: string; fontSize: number };
type CanvasElement = PathElement | ShapeElement | TextElement;
type Camera = { x: number; y: number; zoom: number };
type TextDraft = { point: Point; screenX: number; screenY: number };

const DATABASE = "teachit-native-canvas";
const STORE = "documents";
const DOCUMENT_KEY = "main";
const COLORS = ["#252525", "#6f59d9", "#2387a5", "#d65050", "#2b9666"];
const TOOLS: { id: Tool; label: string; shortcut: string }[] = [
  { id: "select", label: "Select", shortcut: "V" },
  { id: "draw", label: "Draw", shortcut: "P" },
  { id: "rectangle", label: "Rectangle", shortcut: "R" },
  { id: "ellipse", label: "Ellipse", shortcut: "O" },
  { id: "line", label: "Line", shortcut: "L" },
  { id: "arrow", label: "Arrow", shortcut: "A" },
  { id: "text", label: "Text", shortcut: "T" },
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

async function loadDocument(): Promise<{ elements: CanvasElement[]; camera: Camera } | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(DOCUMENT_KEY);
    request.onsuccess = () => resolve(request.result as { elements: CanvasElement[]; camera: Camera } | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function saveDocument(value: { elements: CanvasElement[]; camera: Camera }) {
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

function translate(element: CanvasElement, dx: number, dy: number): CanvasElement {
  if (element.type === "freehand") {
    return { ...element, points: element.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
  }
  return { ...element, x: element.x + dx, y: element.y + dy };
}

function ElementView({ element, selected }: {
  element: CanvasElement;
  selected: boolean;
}) {
  const hitProps = {
    "data-canvas-id": element.id,
  };
  const hitStyle = { cursor: "move", pointerEvents: "all" as const };
  const selection = selected ? bounds(element) : null;
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
            fill={element.type === "rectangle" || element.type === "ellipse" ? "transparent" : "none"}
            stroke={element.stroke}
            strokeWidth={element.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={hitStyle}
          />
        </>
      )}
      {selection && (
        <rect
          x={selection.x - 6}
          y={selection.y - 6}
          width={selection.width + 12}
          height={selection.height + 12}
          rx={3}
          fill="none"
          stroke="#715ed5"
          strokeWidth={1.2}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
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
  const gestureRef = useRef<{
    kind: "draw" | "shape" | "move" | "pan";
    pointerId: number;
    start: Point;
    startScreen: Point;
    initial?: CanvasElement;
    before?: CanvasElement[];
  } | null>(null);
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [stroke, setStroke] = useState(COLORS[0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CanvasElement | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [loaded, setLoaded] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [textValue, setTextValue] = useState("");
  const [spaceDown, setSpaceDown] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");

  useEffect(() => {
    let active = true;
    void loadDocument().then((document) => {
      if (!active) return;
      const restored = document?.elements ?? [];
      elementsRef.current = restored;
      setElements(restored);
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
      void saveDocument({ elements, camera }).then(() => {
        setSaveNotice("Saved on this Mac");
        window.setTimeout(() => setSaveNotice(""), 1800);
      }).catch((error) => {
        console.error("Could not save the TeachIt canvas.", error);
        setSaveNotice("Couldn't save canvas");
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [elements, camera, loaded]);

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

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(elementsRef.current);
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(true);
    setCurrentElements(previous);
    setSelectedId(null);
  }, [setCurrentElements]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(elementsRef.current);
    setCanUndo(true);
    setCanRedo(redoRef.current.length > 0);
    setCurrentElements(next);
    setSelectedId(null);
  }, [setCurrentElements]);

  const toWorld = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left - camera.x) / camera.zoom,
      y: (event.clientY - rect.top - camera.y) / camera.zoom,
    };
  }, [camera]);

  const startText = (event: ReactPointerEvent<SVGSVGElement>, point: Point) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTextValue("");
    setTextDraft({ point, screenX: event.clientX - rect.left, screenY: event.clientY - rect.top });
  };

  const commitText = () => {
    if (!textDraft || !textValue.trim()) {
      setTextDraft(null);
      return;
    }
    const next: TextElement = {
      id: randomId(), type: "text", x: textDraft.point.x, y: textDraft.point.y,
      text: textValue.trim(), stroke, strokeWidth: 2, fontSize: 24,
    };
    commit([...elementsRef.current, next]);
    setSelectedId(next.id);
    setTextDraft(null);
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const world = toWorld(event);
    const screen = { x: event.clientX, y: event.clientY };
    const target = event.target as Element;
    const hitId = target.closest("[data-canvas-id]")?.getAttribute("data-canvas-id") ?? null;
    const moving = event.button === 1 || tool === "pan" || spaceDown;
    event.currentTarget.setPointerCapture(event.pointerId);

    if (moving) {
      gestureRef.current = { kind: "pan", pointerId: event.pointerId, start: world, startScreen: screen };
      return;
    }
    if (tool === "select") {
      if (hitId) {
        setSelectedId(hitId);
        const initial = elementsRef.current.find((element) => element.id === hitId);
        if (initial) {
          gestureRef.current = {
            kind: "move", pointerId: event.pointerId, start: world, startScreen: screen,
            initial, before: elementsRef.current,
          };
        }
      } else {
        setSelectedId(null);
      }
      return;
    }
    if (tool === "text") {
      startText(event, world);
      return;
    }
    const id = randomId();
    if (tool === "draw") {
      const next: PathElement = { id, type: "freehand", points: [world], stroke, strokeWidth: 2.4 };
      gestureRef.current = { kind: "draw", pointerId: event.pointerId, start: world, startScreen: screen };
      setDraft(next);
      return;
    }
    if (["rectangle", "ellipse", "line", "arrow"].includes(tool)) {
      const next: ShapeElement = {
        id, type: tool as ShapeKind, x: world.x, y: world.y, width: 0, height: 0,
        stroke, strokeWidth: 2.2,
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
    if (gesture.kind === "move" && gesture.initial) {
      const dx = world.x - gesture.start.x;
      const dy = world.y - gesture.start.y;
      const next = elementsRef.current.map((element) => element.id === gesture.initial?.id ? translate(gesture.initial, dx, dy) : element);
      setCurrentElements(next);
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
    if (gesture.kind === "move") {
      const moved = Math.hypot(event.clientX - gesture.startScreen.x, event.clientY - gesture.startScreen.y) > 2;
      if (moved && gesture.before) {
        undoRef.current = [...undoRef.current, gesture.before].slice(-100);
        redoRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
      }
    } else if (gesture.kind === "draw" || gesture.kind === "shape") {
      const completed = draft;
      const moved = Math.hypot(event.clientX - gesture.startScreen.x, event.clientY - gesture.startScreen.y) > 2;
      if (completed && moved) {
        commit([...elementsRef.current, completed]);
        setSelectedId(completed.id);
      }
      setDraft(null);
    }
    gestureRef.current = null;
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (event.shiftKey) {
      setCamera((current) => ({ ...current, x: current.x - event.deltaY }));
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0012);
    setCamera((current) => {
      const zoom = Math.min(4, Math.max(0.2, current.zoom * factor));
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
      if (event.key === "Backspace" || event.key === "Delete") {
        if (!selectedId) return;
        commit(elementsRef.current.filter((element) => element.id !== selectedId));
        setSelectedId(null);
        return;
      }
      if (event.key === "Escape") { setSelectedId(null); setDraft(null); setTextDraft(null); return; }
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
  }, [commit, redo, selectedId, undo]);

  const zoomBy = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const sx = rect ? rect.width / 2 : 0;
    const sy = rect ? rect.height / 2 : 0;
    setCamera((current) => {
      const zoom = Math.min(4, Math.max(0.2, current.zoom * factor));
      const worldX = (sx - current.x) / current.zoom;
      const worldY = (sy - current.y) / current.zoom;
      return { x: sx - worldX * zoom, y: sy - worldY * zoom, zoom };
    });
  };

  const drawnElements = draft ? [...elements, draft] : elements;
  const textStyle: CSSProperties = textDraft ? { left: textDraft.screenX + 4, top: textDraft.screenY + 4 } : {};
  const cursorClass = tool === "draw" ? "cursor-draw" : tool === "text" ? "cursor-text" : tool === "pan" || spaceDown ? "cursor-pan" : "";

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
      <div className={`native-canvas-shell ${cursorClass}`}>
        <div className="native-palette" role="group" aria-label="Stroke color">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`native-color${stroke === color ? " is-active" : ""}`}
              style={{ backgroundColor: color }}
              aria-label={`Use ${color} stroke`}
              aria-pressed={stroke === color}
              onClick={() => setStroke(color)}
            />
          ))}
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
                selected={selectedId === element.id && element !== draft}
              />
            ))}
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
    case "pan": return <svg viewBox="0 0 24 24"><path d="M8 11V5a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v6c0 4-2 7-6 7h-2c-2 0-3-1-4-2l-4-4a1.5 1.5 0 0 1 2-2l3 2" /></svg>;
  }
}

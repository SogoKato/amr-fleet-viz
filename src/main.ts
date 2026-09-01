import { ConfigError, resolveConfig } from "./config";
import { MapEditor } from "./editor";
import { Renderer } from "./renderer";
import { proximityPairs, Simulation, type RobotState } from "./simulation";
import type { FleetConfig } from "./types";

const PROXIMITY_THRESHOLD_M = 0.8;
const SAMPLES = ["warehouse-loop.json", "crossing-demo.json"];

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = new Renderer(canvas);

const playPauseBtn = document.getElementById("play-pause") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const speedSelect = document.getElementById("sim-speed") as HTMLSelectElement;
const clockEl = document.getElementById("clock")!;
const loadBtn = document.getElementById("load") as HTMLButtonElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const editToggleBtn = document.getElementById("edit-toggle") as HTMLButtonElement;
const editorPanelEl = document.getElementById("editor-panel")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const samplesSelect = document.getElementById("samples") as HTMLSelectElement;
const scenarioNameEl = document.getElementById("scenario-name")!;
const errorEl = document.getElementById("error")!;
const robotListEl = document.getElementById("robot-list")!;

let rawConfig: FleetConfig | null = null;
let lastGoodJson = "";
let sourceName = "";
let simulation: Simulation | null = null;
let simTime = 0;
let playing = true;
let simSpeed = 1;
let lastFrame = performance.now();

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

function clearError(): void {
  errorEl.style.display = "none";
}

/** Re-validate rawConfig and rebuild the simulation; revert on failure. */
function applyChanges(): boolean {
  if (!rawConfig) return false;
  try {
    const resolved = resolveConfig(rawConfig);
    simulation = new Simulation(resolved);
    lastGoodJson = JSON.stringify(rawConfig);
    scenarioNameEl.textContent = `${resolved.name} (${sourceName})`;
    clearError();
    return true;
  } catch (err) {
    showError(`Rejected edit: ${err instanceof Error ? err.message : String(err)}`);
    rawConfig = JSON.parse(lastGoodJson) as FleetConfig;
    return false;
  }
}

function loadConfigObject(parsed: FleetConfig, name: string): void {
  try {
    const resolved = resolveConfig(parsed);
    rawConfig = parsed;
    lastGoodJson = JSON.stringify(parsed);
    sourceName = name;
    simulation = new Simulation(resolved);
    simTime = 0;
    playing = true;
    playPauseBtn.textContent = "Pause";
    scenarioNameEl.textContent = `${resolved.name} (${name})`;
    editor.reset();
    clearError();
  } catch (err) {
    const prefix = err instanceof ConfigError ? "Invalid config" : "Failed to load config";
    showError(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadConfigText(text: string, name: string): void {
  try {
    loadConfigObject(JSON.parse(text) as FleetConfig, name);
  } catch (err) {
    showError(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadSample(name: string): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}configs/${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadConfigText(await res.text(), name);
  } catch (err) {
    showError(`Failed to fetch sample "${name}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

const editor = new MapEditor(canvas, renderer, editorPanelEl, {
  getRaw: () => rawConfig,
  getResolved: () => simulation?.config ?? null,
  applyChanges,
  showMessage: showError,
});

function renderSidebar(states: RobotState[], near: Set<RobotState>): void {
  if (states.length === 0) {
    const empty = document.createElement("p");
    empty.className = "rstatus";
    empty.textContent = "No robots — add one in Edit map.";
    robotListEl.replaceChildren(empty);
    return;
  }
  robotListEl.replaceChildren(
    ...states.map((state) => {
      const row = document.createElement("div");
      row.className = near.has(state) ? "robot-row near" : "robot-row";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = state.robot.color;
      const id = document.createElement("span");
      id.className = "rid";
      id.textContent = state.robot.id;
      const status = document.createElement("span");
      status.className = "rstatus";
      status.textContent = state.status;
      row.append(dot, id, status);
      return row;
    }),
  );
}

function frame(now: number): void {
  const dt = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;
  if (playing) simTime += dt * simSpeed;

  if (simulation) {
    const states = simulation.statesAt(simTime);
    const near = new Set<RobotState>();
    for (const [a, b] of proximityPairs(states, PROXIMITY_THRESHOLD_M)) {
      near.add(a);
      near.add(b);
    }
    renderer.draw(simulation.config, states, near, editor.highlight());
    renderSidebar(states, near);
    clockEl.textContent = `t = ${simTime.toFixed(1)}s`;
  }
  requestAnimationFrame(frame);
}

playPauseBtn.addEventListener("click", () => {
  playing = !playing;
  playPauseBtn.textContent = playing ? "Pause" : "Play";
});

resetBtn.addEventListener("click", () => {
  simTime = 0;
});

speedSelect.addEventListener("change", () => {
  simSpeed = Number(speedSelect.value);
});

loadBtn.addEventListener("click", () => fileInput.click());

saveBtn.addEventListener("click", () => {
  if (!rawConfig) return;
  const blob = new Blob([JSON.stringify(rawConfig, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = sourceName.endsWith(".json") ? sourceName : "scenario.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

function setEditMode(on: boolean): void {
  editor.setEnabled(on);
  editToggleBtn.classList.toggle("active", on);
  editToggleBtn.textContent = on ? "Done editing" : "Edit map";
}

editToggleBtn.addEventListener("click", () => setEditMode(!editor.enabled));

document.getElementById("new")!.addEventListener("click", () => {
  loadConfigObject({ name: "New scenario", map: { nodes: [] }, robots: [] }, "unsaved");
  setEditMode(true); // a blank scenario is only useful in edit mode
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (file) loadConfigText(await file.text(), file.name);
  fileInput.value = "";
});

for (const name of SAMPLES) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  samplesSelect.append(option);
}
samplesSelect.addEventListener("change", () => loadSample(samplesSelect.value));

// Drag & drop config files anywhere on the page.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) document.body.classList.remove("dragging");
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const file = e.dataTransfer?.files[0];
  if (file) loadConfigText(await file.text(), file.name);
});

void loadSample(SAMPLES[0]);
requestAnimationFrame(frame);

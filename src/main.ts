import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { layers, namedFlavor } from "@protomaps/basemaps";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  StyleSpecification,
} from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import { DEMO_TRACE, PMTILES_URL, TILE_ZOOM } from "./config";
import type { LngLat } from "./geo";
import { matchTrace, type MatchResult } from "./matcher";
import { selectedRoadFragments } from "./road-fragments";
import { ProtomapsRoadSource, type RoadFetchResult } from "./road-source";

type InteractionMode = "draw" | "pan";

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const drawModeButton = $("#draw-mode");
const panModeButton = $("#pan-mode");
const mapHint = $("#map-hint");
const loadDemoButton = $("#load-demo");
const undoButton = $("#undo-point") as HTMLButtonElement;
const clearButton = $("#clear-all");
const runButton = $("#run-match") as HTMLButtonElement;
const pointCount = $("#point-count");
const status = $("#status");
const results = $("#results") as HTMLElement;
const snapRadiusInput = $("#snap-radius") as HTMLInputElement;
const snapRadiusValue = $("#snap-radius-value") as HTMLOutputElement;
const candidateCountInput = $("#candidate-count") as HTMLInputElement;
const candidateCountValue = $("#candidate-count-value") as HTMLOutputElement;
const sequenceInput = $("#sequence-aware") as HTMLInputElement;
const trimEdgesInput = $("#trim-edges") as HTMLInputElement;

const protocol = new Protocol();
maplibregl.setWorkerUrl(maplibreWorkerUrl);
maplibregl.addProtocol("pmtiles", protocol.tile);
const archive = new PMTiles(PMTILES_URL);
protocol.add(archive);
const roadSource = new ProtomapsRoadSource(archive, TILE_ZOOM);

const style: StyleSpecification = {
  version: 8,
  glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
  sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/light",
  sources: {
    protomaps: {
      type: "vector",
      url: `pmtiles://${PMTILES_URL}`,
      attribution:
        '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: layers("protomaps", namedFlavor("light"), { lang: "en" }),
};

const map: MapLibreMap = new maplibregl.Map({
  container: "map",
  style,
  center: [-122.2711, 37.8044],
  zoom: 14.4,
  minZoom: 3,
  maxZoom: 18,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

let observations: LngLat[] = [];
let mode: InteractionMode = "draw";
let mapReady = false;
let running = false;
let lastResult: {
  match: MatchResult;
  fetch: RoadFetchResult;
  elapsedMs: number;
} | null = null;

const emptyCollection = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });

function getSource(id: string): GeoJSONSource | undefined {
  return map.getSource(id) as GeoJSONSource | undefined;
}

function lineFeature(coordinates: LngLat[], properties = {}): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    properties,
    geometry: { type: "LineString", coordinates },
  };
}

function setMode(nextMode: InteractionMode): void {
  mode = nextMode;
  const drawing = mode === "draw";
  drawModeButton.classList.toggle("active", drawing);
  panModeButton.classList.toggle("active", !drawing);
  map.getCanvas().classList.toggle("draw-cursor", drawing);
  mapHint.textContent = drawing
    ? "Click along a road to sketch a noisy trace"
    : "Drag to pan · scroll to zoom";
}

function setStatus(message: string, kind: "normal" | "error" | "success" = "normal"): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

function updateRawTrace(announce = true): void {
  pointCount.textContent = `${observations.length} observation${observations.length === 1 ? "" : "s"}`;
  undoButton.disabled = observations.length === 0 || running;
  runButton.disabled = observations.length < 2 || running;

  const features: GeoJSON.Feature[] = observations.map((coordinate, index) => ({
    type: "Feature",
    properties: { index: index + 1 },
    geometry: { type: "Point", coordinates: coordinate },
  }));
  if (observations.length > 1) features.unshift(lineFeature(observations));
  getSource("raw-trace")?.setData({ type: "FeatureCollection", features });

  if (announce) {
    if (observations.length < 2) {
      setStatus("Add at least two observations or load the example.");
    } else {
      setStatus(`${observations.length} observations ready. Run the local matcher.`);
    }
  }
}

function clearResultLayers(): void {
  getSource("matched-trace")?.setData(emptyCollection());
  getSource("selected-roads")?.setData(emptyCollection());
  results.hidden = true;
  lastResult = null;
}

function fitObservations(): void {
  if (observations.length === 0) return;
  const bounds = observations.reduce(
    (box, point) => box.extend(point),
    new maplibregl.LngLatBounds(observations[0], observations[0]),
  );
  map.fitBounds(bounds, {
    padding: { top: 100, right: 90, bottom: 100, left: window.innerWidth > 760 ? 470 : 60 },
    maxZoom: 15.2,
    duration: 800,
  });
}

function showResult(match: MatchResult, fetch: RoadFetchResult, totalElapsedMs: number): void {
  const successful = match.matches.filter((item) => item !== null);
  const matchFeatures: GeoJSON.Feature[] = [];
  let block: LngLat[] = [];

  const flushBlock = (): void => {
    if (block.length > 1) matchFeatures.push(lineFeature(block, { kind: "matched" }));
    block = [];
  };

  match.matches.forEach((item) => {
    if (!item) {
      flushBlock();
      return;
    }
    block.push(item.candidate.point);
    matchFeatures.push({
      type: "Feature",
      properties: {
        error: item.candidate.distance,
        road: item.candidate.road.kindDetail,
      },
      geometry: { type: "Point", coordinates: item.candidate.point },
    });
  });
  flushBlock();

  const roadFeatures = selectedRoadFragments(match, trimEdgesInput.checked).map((fragment) =>
    lineFeature(fragment.coordinates, {
      kind: fragment.road.kind,
      detail: fragment.road.kindDetail,
    }),
  );

  getSource("matched-trace")?.setData({ type: "FeatureCollection", features: matchFeatures });
  getSource("selected-roads")?.setData({ type: "FeatureCollection", features: roadFeatures });

  $("#matched-metric").textContent = `${successful.length}/${observations.length}`;
  $("#error-metric").textContent = `${match.meanErrorMeters.toFixed(1)} m`;
  $("#tiles-metric").textContent = String(fetch.tileCount);
  $("#time-metric").textContent = `${Math.round(totalElapsedMs)} ms`;
  $("#result-mode").textContent = sequenceInput.checked ? "sequence-aware" : "nearest";
  results.hidden = false;

  const cacheMessage = fetch.cacheHits > 0 ? ` · ${fetch.cacheHits} tile cache hits` : "";
  setStatus(
    `Matched ${successful.length} of ${observations.length} observations against ${fetch.roads.length.toLocaleString()} road lines${cacheMessage}.`,
    successful.length === observations.length ? "success" : "normal",
  );
  lastResult = { match, fetch, elapsedMs: totalElapsedMs };
}

async function runMatch(): Promise<void> {
  if (running || observations.length < 2) return;
  running = true;
  runButton.disabled = true;
  undoButton.disabled = true;
  runButton.classList.add("loading");
  runButton.querySelector("span")!.textContent = "Fetching road tiles";
  clearResultLayers();

  const started = performance.now();
  const radiusMeters = Number(snapRadiusInput.value);

  try {
    const fetched = await roadSource.roadsAround(
      observations,
      radiusMeters,
      (finished, total) => setStatus(`Range-reading z${TILE_ZOOM} road tiles · ${finished}/${total}`),
    );
    setStatus(`Testing candidates across ${fetched.roads.length.toLocaleString()} decoded road lines…`);

    const match = matchTrace(observations, fetched.roads, {
      radiusMeters,
      candidateCount: Number(candidateCountInput.value),
      sequenceAware: sequenceInput.checked,
    });
    showResult(match, fetched, performance.now() - started);
  } catch (error) {
    console.error(error);
    setStatus(
      `Could not read the PMTiles source. ${error instanceof Error ? error.message : "Unknown error"}`,
      "error",
    );
  } finally {
    running = false;
    runButton.classList.remove("loading");
    runButton.querySelector("span")!.textContent = "Run local match";
    updateRawTrace(false);
  }
}

map.on("load", () => {
  mapReady = true;
  map.addSource("raw-trace", { type: "geojson", data: emptyCollection() });
  map.addSource("selected-roads", { type: "geojson", data: emptyCollection() });
  map.addSource("matched-trace", { type: "geojson", data: emptyCollection() });

  const firstSymbol = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  map.addLayer(
    {
      id: "selected-roads",
      type: "line",
      source: "selected-roads",
      paint: {
        "line-color": "#235b89",
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 7],
        "line-opacity": 0.8,
      },
    },
    firstSymbol,
  );
  map.addLayer({
    id: "raw-line",
    type: "line",
    source: "raw-trace",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": "#d95f32",
      "line-width": 2.5,
      "line-dasharray": [1, 2],
      "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "raw-points",
    type: "circle",
    source: "raw-trace",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 5,
      "circle-color": "#fff8ee",
      "circle-stroke-color": "#d95f32",
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: "matched-line",
    type: "line",
    source: "matched-trace",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": "#28c7bd",
      "line-width": 3,
      "line-opacity": 0.95,
    },
  });
  map.addLayer({
    id: "matched-points",
    type: "circle",
    source: "matched-trace",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 4,
      "circle-color": "#f9fffe",
      "circle-stroke-color": "#087d78",
      "circle-stroke-width": 2,
    },
  });

  setMode("draw");
  updateRawTrace();
});

map.on("click", (event) => {
  if (!mapReady || mode !== "draw" || running) return;
  observations.push([event.lngLat.lng, event.lngLat.lat]);
  clearResultLayers();
  updateRawTrace();
});

map.on("error", (event) => {
  if (event.error) console.warn("Map source error", event.error);
});

drawModeButton.addEventListener("click", () => setMode("draw"));
panModeButton.addEventListener("click", () => setMode("pan"));

loadDemoButton.addEventListener("click", () => {
  observations = DEMO_TRACE.map((point) => [...point]);
  clearResultLayers();
  updateRawTrace();
  fitObservations();
});

undoButton.addEventListener("click", () => {
  observations.pop();
  clearResultLayers();
  updateRawTrace();
});

clearButton.addEventListener("click", () => {
  observations = [];
  clearResultLayers();
  updateRawTrace();
});

runButton.addEventListener("click", () => void runMatch());

snapRadiusInput.addEventListener("input", () => {
  snapRadiusValue.value = `${snapRadiusInput.value} m`;
});

candidateCountInput.addEventListener("input", () => {
  candidateCountValue.value = candidateCountInput.value;
});

trimEdgesInput.addEventListener("change", () => {
  if (lastResult) {
    showResult(lastResult.match, lastResult.fetch, lastResult.elapsedMs);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "d") setMode("draw");
  if (event.key === "Escape") setMode("pan");
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoButton.click();
  }
  if (event.key.toLowerCase() === "m" && !runButton.disabled) void runMatch();
});

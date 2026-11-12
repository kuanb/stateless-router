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
import type { MapMatchResponse } from "./api-types";
import { DEMO_TRACE, PMTILES_URL } from "./config";
import type { LngLat } from "./geo";
import { MapMatchPageClient } from "./map-match-page-client";

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
const matcherApi = new MapMatchPageClient(
  new URL("../map-match-api-v1/", window.location.href),
);

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
let lastResult: MapMatchResponse | null = null;

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
      setStatus(`${observations.length} observations ready. Call the browser endpoint.`);
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

function showResult(response: MapMatchResponse): void {
  const edgeFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = response.edges.map((edge) => ({
    type: "Feature",
    id: edge.id,
    properties: {
      edge_id: edge.id,
      start_node: edge.startNode,
      end_node: edge.endNode,
      direction: edge.direction,
      geometry_order: edge.geometryOrder,
      ...edge.properties,
    },
    geometry: trimEdgesInput.checked ? edge.geometry : edge.sourceGeometry,
  }));

  getSource("matched-trace")?.setData(response.render.matches);
  getSource("selected-roads")?.setData({ type: "FeatureCollection", features: edgeFeatures });

  $("#matched-metric").textContent = `${response.stats.matched}/${response.stats.total}`;
  $("#error-metric").textContent = `${response.stats.meanErrorMeters.toFixed(1)} m`;
  $("#tiles-metric").textContent = String(response.stats.tilesRequested);
  $("#time-metric").textContent = `${Math.round(response.stats.elapsedMs)} ms`;
  $("#result-mode").textContent = response.request.options.sequenceAware
    ? "sequence-aware"
    : "nearest";
  results.hidden = false;

  const cacheMessage = response.stats.tileCacheHits > 0
    ? ` · ${response.stats.tileCacheHits} tile cache hits`
    : "";
  setStatus(
    `API returned ${response.edges.length} edges and ${response.nodes.length} endpoint nodes for ${response.stats.matched}/${response.stats.total} probes${cacheMessage}.`,
    response.stats.matched === response.stats.total ? "success" : "normal",
  );
  lastResult = response;
}

async function runMatch(): Promise<void> {
  if (running || observations.length < 2) return;
  running = true;
  runButton.disabled = true;
  undoButton.disabled = true;
  runButton.classList.add("loading");
  runButton.querySelector("span")!.textContent = "Calling browser API";
  clearResultLayers();

  const radiusMeters = Number(snapRadiusInput.value);

  try {
    const response = await matcherApi.match(
      {
        coordinates: observations,
        options: {
          radiusMeters,
          candidateCount: Number(candidateCountInput.value),
          sequenceAware: sequenceInput.checked,
          edgePaddingMeters: 0,
        },
      },
      (progress) => setStatus(progress.message),
    );
    showResult(response);
  } catch (error) {
    console.error(error);
    setStatus(
      `Could not read the PMTiles source. ${error instanceof Error ? error.message : "Unknown error"}`,
      "error",
    );
  } finally {
    running = false;
    runButton.classList.remove("loading");
    runButton.querySelector("span")!.textContent = "Call matcher API";
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
    showResult(lastResult);
  }
});

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) matcherApi.dispose();
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

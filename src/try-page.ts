import "./try-style.css";

import type { MapMatchRequest, MapMatchResponse } from "./api-types";
import { DEMO_TRACE } from "./config";
import { MapMatchPageClient } from "./map-match-page-client";
import { parseTryRequest, requestUrl, tryRequestFromSearch } from "./try-request";

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const input = $("#coordinates") as HTMLTextAreaElement;
const output = $("#response");
const status = $("#try-status");
const runButton = $("#run-match") as HTMLButtonElement;
const copyButton = $("#copy-json") as HTMLButtonElement;
const shareButton = $("#copy-url") as HTMLButtonElement;
const summary = $("#try-summary");
const client = new MapMatchPageClient(
  new URL("../map-match-api-v1/", window.location.href),
);
let lastResponse: MapMatchResponse | null = null;

function setStatus(message: string, kind: "normal" | "error" | "success" = "normal"): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setInput(request: MapMatchRequest): void {
  input.value = JSON.stringify(request.coordinates, null, 2);
}

function currentRequest(): MapMatchRequest {
  const parsed = parseTryRequest(input.value);
  return {
    coordinates: parsed.coordinates,
    options: parsed.options ?? {
      radiusMeters: 70,
      candidateCount: 6,
      sequenceAware: true,
      edgePaddingMeters: 0,
    },
  };
}

function showResponse(response: MapMatchResponse): void {
  lastResponse = response;
  output.textContent = JSON.stringify(response, null, 2);
  $("#try-matched").textContent = `${response.stats.matched}/${response.stats.total}`;
  $("#try-edges").textContent = String(response.edges.length);
  $("#try-nodes").textContent = String(response.nodes.length);
  $("#try-time").textContent = `${Math.round(response.stats.elapsedMs)} ms`;
  summary.hidden = false;
  copyButton.disabled = false;
  setStatus(
    `Done · ${response.edges.length} edges and ${response.nodes.length} synthetic endpoint nodes`,
    "success",
  );
}

async function run(): Promise<void> {
  if (runButton.disabled) return;
  runButton.disabled = true;
  runButton.textContent = "Matching…";
  copyButton.disabled = true;
  summary.hidden = true;
  lastResponse = null;
  try {
    const response = await client.match(
      currentRequest(),
      (progress) => setStatus(progress.message),
    );
    showResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown request error";
    output.textContent = JSON.stringify({ error: message }, null, 2);
    setStatus(message, "error");
  } finally {
    runButton.disabled = false;
    runButton.textContent = "Run map match →";
  }
}

function temporaryLabel(button: HTMLButtonElement, label: string): void {
  const previous = button.textContent ?? "";
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1_200);
}

runButton.addEventListener("click", () => void run());
$("#load-example").addEventListener("click", () => {
  setInput({ coordinates: DEMO_TRACE });
  setStatus("Oakland coordinates loaded. Ready to run.");
});
copyButton.addEventListener("click", () => {
  if (!lastResponse) return;
  void navigator.clipboard
    .writeText(JSON.stringify(lastResponse, null, 2))
    .then(() => temporaryLabel(copyButton, "Copied JSON"));
});
shareButton.addEventListener("click", () => {
  try {
    const url = requestUrl(new URL(window.location.href), currentRequest());
    void navigator.clipboard.writeText(url).then(() => temporaryLabel(shareButton, "Copied URL"));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Invalid coordinates", "error");
  }
});

const queryRequest = (() => {
  try {
    return tryRequestFromSearch(window.location.search);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Invalid coordinates query", "error");
    return null;
  }
})();

if (queryRequest) {
  setInput(queryRequest);
  void run();
} else {
  setInput({ coordinates: DEMO_TRACE });
}

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) client.dispose();
});

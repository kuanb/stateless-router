import "./api-style.css";

import type {
  MapMatchProgress,
  MapMatchRequest,
  MapMatchResponse,
  MatchRpcErrorMessage,
  MatchRpcProgressMessage,
  MatchRpcReadyMessage,
  MatchRpcRequestMessage,
  MatchRpcResponseMessage,
} from "./api-types";
import { DEMO_TRACE } from "./config";
import { BrowserMapMatchService } from "./map-match-service";

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const service = new BrowserMapMatchService();
const requestInput = $("#request-json") as HTMLTextAreaElement;
const responseOutput = $("#response-json");
const runButton = $("#run-request") as HTMLButtonElement;
const resetButton = $("#reset-request") as HTMLButtonElement;
const copyButton = $("#copy-response") as HTMLButtonElement;
const status = $("#api-status");
const resultSummary = $("#result-summary");
let lastResponse: MapMatchResponse | null = null;

const exampleRequest: MapMatchRequest = {
  coordinates: DEMO_TRACE,
  options: {
    radiusMeters: 70,
    candidateCount: 6,
    sequenceAware: true,
    edgePaddingMeters: 0,
  },
};

function setStatus(message: string, kind: "normal" | "error" | "success" = "normal"): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setExample(): void {
  requestInput.value = JSON.stringify(exampleRequest, null, 2);
}

function showResponse(response: MapMatchResponse): void {
  lastResponse = response;
  responseOutput.textContent = JSON.stringify(response, null, 2);
  $("#summary-matched").textContent = `${response.stats.matched}/${response.stats.total}`;
  $("#summary-edges").textContent = String(response.edges.length);
  $("#summary-nodes").textContent = String(response.nodes.length);
  $("#summary-time").textContent = `${Math.round(response.stats.elapsedMs)} ms`;
  resultSummary.hidden = false;
  copyButton.disabled = false;
  setStatus(
    `200-like response · ${response.edges.length} edges · ${response.nodes.length} endpoint nodes`,
    "success",
  );
}

async function execute(
  input: unknown,
  onProgress = (progress: MapMatchProgress): void => setStatus(progress.message),
): Promise<MapMatchResponse> {
  return service.match(input, onProgress);
}

async function runManualRequest(): Promise<void> {
  if (runButton.disabled) return;
  runButton.disabled = true;
  runButton.textContent = "Matching…";
  resultSummary.hidden = true;
  try {
    const input = JSON.parse(requestInput.value) as unknown;
    showResponse(await execute(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown request error";
    responseOutput.textContent = JSON.stringify({ error: message }, null, 2);
    setStatus(`400-like response · ${message}`, "error");
  } finally {
    runButton.disabled = false;
    runButton.textContent = "Run request →";
  }
}

function reply(target: Window, origin: string, message: object): void {
  target.postMessage(message, origin);
}

window.addEventListener("message", (event: MessageEvent<MatchRpcRequestMessage>) => {
  const message = event.data;
  if (!message || message.type !== "stateless-router:match:v1" || !event.source) return;
  const target = event.source as Window;
  const forwardProgress = (progress: MapMatchProgress): void => {
    const result: MatchRpcProgressMessage = {
      type: "stateless-router:progress:v1",
      id: message.id,
      progress,
    };
    reply(target, event.origin, result);
  };
  forwardProgress({
    stage: "fetching",
    message: "Request accepted by the browser endpoint…",
  });
  void execute(message.request, forwardProgress)
    .then((response) => {
      const result: MatchRpcResponseMessage = {
        type: "stateless-router:response:v1",
        id: message.id,
        response,
      };
      reply(target, event.origin, result);
    })
    .catch((error) => {
      const result: MatchRpcErrorMessage = {
        type: "stateless-router:error:v1",
        id: message.id,
        error: error instanceof Error ? error.message : "Unknown request error",
      };
      reply(target, event.origin, result);
    });

});

runButton.addEventListener("click", () => void runManualRequest());
resetButton.addEventListener("click", () => {
  setExample();
  setStatus("Oakland request restored. Ready to run.");
});
copyButton.addEventListener("click", () => {
  if (!lastResponse) return;
  void navigator.clipboard.writeText(JSON.stringify(lastResponse, null, 2)).then(() => {
    copyButton.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.textContent = "Copy JSON";
    }, 1_200);
  });
});

setExample();
const ready: MatchRpcReadyMessage = { type: "stateless-router:ready:v1" };
if (window.parent !== window) window.parent.postMessage(ready, "*");

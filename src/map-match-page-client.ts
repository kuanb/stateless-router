import type {
  MapMatchProgress,
  MapMatchRequest,
  MapMatchResponse,
  MatchRpcMessage,
  MatchRpcRequestMessage,
} from "./api-types";

interface PendingRequest {
  resolve: (response: MapMatchResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: MapMatchProgress) => void;
}

// Bump when the page-backed service implementation changes. GitHub Pages can
// cache HTML for ten minutes, so the iframe URL must identify its code version.
const ENDPOINT_PAGE_VERSION = "route-inference-v3";

export class MapMatchPageClient {
  private readonly iframe: HTMLIFrameElement;
  private readonly endpointOrigin: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ready: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private requestCounter = 0;

  constructor(endpoint: URL) {
    this.endpointOrigin = endpoint.origin;
    this.iframe = document.createElement("iframe");
    this.iframe.hidden = true;
    this.iframe.title = "Stateless Router map match service";
    const iframeUrl = new URL(endpoint.href);
    iframeUrl.searchParams.set("embedded", "1");
    iframeUrl.searchParams.set("serviceVersion", ENDPOINT_PAGE_VERSION);
    this.iframe.src = iframeUrl.href;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    window.addEventListener("message", this.handleMessage);
    document.body.append(this.iframe);
  }

  async match(
    request: MapMatchRequest,
    onProgress?: (progress: MapMatchProgress) => void,
  ): Promise<MapMatchResponse> {
    await this.ready;
    const id = `request:${Date.now()}:${this.requestCounter += 1}`;
    const message: MatchRpcRequestMessage = {
      type: "stateless-router:match:v1",
      id,
      request,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.iframe.contentWindow?.postMessage(message, this.endpointOrigin);
    });
  }

  dispose(): void {
    window.removeEventListener("message", this.handleMessage);
    this.pending.forEach(({ reject }) => reject(new Error("Map match client was disposed.")));
    this.pending.clear();
    this.iframe.remove();
  }

  private readonly handleMessage = (event: MessageEvent<MatchRpcMessage>): void => {
    if (event.source !== this.iframe.contentWindow || event.origin !== this.endpointOrigin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "stateless-router:ready:v1") {
      this.resolveReady?.();
      this.resolveReady = null;
      return;
    }
    if (!("id" in message)) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    if (message.type === "stateless-router:progress:v1") {
      request.onProgress?.(message.progress);
      return;
    }
    this.pending.delete(message.id);
    if (message.type === "stateless-router:response:v1") {
      request.resolve(message.response);
    } else if (message.type === "stateless-router:error:v1") {
      request.reject(new Error(message.error));
    }
  };
}

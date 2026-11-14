import { PMTiles } from "pmtiles";
import {
  OVERTURE_PMTILES_URL,
  OVERTURE_RELEASE,
  OVERTURE_TILE_ZOOM,
  PMTILES_URL,
  TILE_ZOOM,
} from "./config";
import { matchTrace } from "./matcher";
import { buildMapMatchResponse, resolveMapMatchRequest } from "./map-match-response";
import { createOvertureTransitionDistance } from "./overture-router";
import { OvertureRoadSource } from "./overture-source";
import { ProtomapsRoadSource, type RoadSource } from "./road-source";
import type {
  MapMatchProgress,
  MapMatchRequest,
  MapMatchResponse,
} from "./api-types";

export type MapMatchNetworkMode = "protomaps" | "overture";

export class BrowserMapMatchService {
  private readonly roadSource: RoadSource;
  private readonly tileZoom: number;
  private readonly source: MapMatchResponse["source"];

  constructor(readonly mode: MapMatchNetworkMode = "protomaps") {
    if (mode === "overture") {
      this.tileZoom = OVERTURE_TILE_ZOOM;
      this.roadSource = new OvertureRoadSource(
        new PMTiles(OVERTURE_PMTILES_URL),
        OVERTURE_TILE_ZOOM,
      );
      this.source = {
        kind: "pmtiles",
        network: "overture_transportation",
        tileZoom: OVERTURE_TILE_ZOOM,
        archive: OVERTURE_PMTILES_URL,
        release: OVERTURE_RELEASE,
      };
    } else {
      this.tileZoom = TILE_ZOOM;
      this.roadSource = new ProtomapsRoadSource(
        new PMTiles(PMTILES_URL),
        TILE_ZOOM,
      );
      this.source = {
        kind: "pmtiles",
        network: "protomaps_geometry",
        tileZoom: TILE_ZOOM,
        archive: PMTILES_URL,
      };
    }
  }

  async match(
    input: MapMatchRequest | unknown,
    onProgress?: (progress: MapMatchProgress) => void,
  ): Promise<MapMatchResponse> {
    const request = resolveMapMatchRequest(input);
    const started = performance.now();
    const fetched = await this.roadSource.roadsAround(
      request.coordinates,
      request.options.radiusMeters,
      (completed, total) =>
        onProgress?.({
          stage: "fetching",
          completed,
          total,
          message: `Range-reading z${this.tileZoom} ${this.mode === "overture" ? "Overture transportation" : "Protomaps road"} tiles · ${completed}/${total}`,
        }),
    );

    onProgress?.({
      stage: "matching",
      message: `Testing candidates across ${fetched.roads.length.toLocaleString()} decoded road lines…`,
    });
    const match = matchTrace(request.coordinates, fetched.roads, {
      radiusMeters: request.options.radiusMeters,
      candidateCount: request.options.candidateCount,
      sequenceAware: request.options.sequenceAware,
      ...(this.mode === "overture"
        ? { networkDistance: createOvertureTransitionDistance(fetched.roads) }
        : {}),
    });

    onProgress?.({
      stage: "serializing",
      message: "Serializing render-ready edges, nodes, and probe matches…",
    });
    return buildMapMatchResponse(
      request,
      match,
      fetched,
      performance.now() - started,
      this.source,
    );
  }
}

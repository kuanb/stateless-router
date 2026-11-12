import { PMTiles } from "pmtiles";
import { PMTILES_URL, TILE_ZOOM } from "./config";
import { matchTrace } from "./matcher";
import { buildMapMatchResponse, resolveMapMatchRequest } from "./map-match-response";
import { ProtomapsRoadSource } from "./road-source";
import type {
  MapMatchProgress,
  MapMatchRequest,
  MapMatchResponse,
} from "./api-types";

export class BrowserMapMatchService {
  private readonly roadSource = new ProtomapsRoadSource(
    new PMTiles(PMTILES_URL),
    TILE_ZOOM,
  );

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
          message: `Range-reading z${TILE_ZOOM} road tiles · ${completed}/${total}`,
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
    );
  }
}

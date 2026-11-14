import type { LngLat } from "./geo";

export interface MapMatchRequestOptions {
  radiusMeters?: number;
  candidateCount?: number;
  sequenceAware?: boolean;
  edgePaddingMeters?: number;
  inferRoute?: boolean;
}

export interface MapMatchRequest {
  coordinates: LngLat[];
  options?: MapMatchRequestOptions;
}

export interface ResolvedMapMatchRequest {
  coordinates: LngLat[];
  options: Required<MapMatchRequestOptions>;
}

export interface MapMatchProgress {
  stage: "fetching" | "matching" | "serializing";
  message: string;
  completed?: number;
  total?: number;
}

export interface ApiNode {
  id: string;
  coordinate: LngLat;
  kind: "fragment_endpoint" | "inferred_route_endpoint" | "overture_connector";
  intersectionInferred: false;
  sourceId?: string;
}

export interface ApiEdgeProperties {
  kind: string;
  kindDetail: string;
  name: string | null;
  ref: string | null;
  oneway: string | null;
  access: string | null;
  segmentId?: string | null;
  startConnectorId?: string | null;
  endConnectorId?: string | null;
}

export interface ApiEdge {
  id: string;
  sourceRoadId: string;
  startNode: string;
  endNode: string;
  direction: "forward" | "bidirectional";
  geometryOrder: "matched_travel";
  topology: "unresolved" | "overture_connectors";
  geometry: GeoJSON.LineString;
  sourceGeometry: GeoJSON.LineString;
  properties: ApiEdgeProperties;
}

export interface ApiProbeMatch {
  index: number;
  input: LngLat;
  matched: boolean;
  snapped: LngLat | null;
  distanceMeters: number | null;
  edgeId: string | null;
  travelBearing: number | null;
}

export interface ApiInferredEdge {
  id: string;
  startNode: string;
  endNode: string;
  fromProbe: number;
  toProbe: number;
  distanceMeters: number;
  sourceRoadIds: string[];
  provenance: "inferred_transition";
  confidence: "geometry_only" | "overture_topology";
  geometry: GeoJSON.LineString;
}

export interface ApiRouteTransition {
  fromProbe: number;
  toProbe: number;
  resolved: boolean;
  distanceMeters: number | null;
}

export interface MapMatchResponse {
  schema: "stateless-router/map-match/v1";
  request: ResolvedMapMatchRequest;
  source: {
    kind: "pmtiles";
    network: "protomaps_geometry" | "overture_transportation";
    tileZoom: number;
    archive: string;
    release?: string;
  };
  probes: ApiProbeMatch[];
  nodes: ApiNode[];
  edges: ApiEdge[];
  inferredEdges: ApiInferredEdge[];
  route: {
    edgeSequence: string[];
    inferredEdgeSequence: string[];
    connectivityVerified: boolean;
    connectivityInferred: boolean;
    distanceMeters: number;
    geometry: GeoJSON.MultiLineString | null;
    transitions: ApiRouteTransition[];
  };
  render: {
    edges: GeoJSON.FeatureCollection<GeoJSON.LineString>;
    inferredEdges: GeoJSON.FeatureCollection<GeoJSON.LineString>;
    matches: GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point>;
  };
  stats: {
    matched: number;
    total: number;
    meanErrorMeters: number;
    tilesRequested: number;
    roadsDecoded: number;
    tileCacheHits: number;
    elapsedMs: number;
  };
  warnings: string[];
}

export interface MatchRpcRequestMessage {
  type: "stateless-router:match:v1";
  id: string;
  request: MapMatchRequest;
}

export interface MatchRpcReadyMessage {
  type: "stateless-router:ready:v1";
}

export interface MatchRpcProgressMessage {
  type: "stateless-router:progress:v1";
  id: string;
  progress: MapMatchProgress;
}

export interface MatchRpcResponseMessage {
  type: "stateless-router:response:v1";
  id: string;
  response: MapMatchResponse;
}

export interface MatchRpcErrorMessage {
  type: "stateless-router:error:v1";
  id: string;
  error: string;
}

export type MatchRpcMessage =
  | MatchRpcReadyMessage
  | MatchRpcProgressMessage
  | MatchRpcResponseMessage
  | MatchRpcErrorMessage;

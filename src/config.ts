export const PMTILES_URL =
  "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles";

export const TILE_ZOOM = 15;

export const OVERTURE_RELEASE = "2026-10-21.0";

export const OVERTURE_PMTILES_URL =
  `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${OVERTURE_RELEASE}/transportation.pmtiles`;

export const OVERTURE_TILE_ZOOM = 14;

export const DEMO_TRACE: [number, number][] = [
  [-122.2727, 37.8009],
  [-122.27235, 37.80175],
  [-122.27195, 37.80262],
  [-122.27155, 37.80353],
  [-122.27115, 37.8044],
  [-122.27042, 37.80408],
  [-122.26968, 37.80377],
  [-122.26893, 37.80343],
  [-122.26818, 37.80313],
  [-122.26743, 37.8028],
  [-122.26669, 37.80248],
];

// The Overture example omits one observation whose implied movement conflicts
// with the release's directional access graph. The remaining trace is fully
// connected through explicit transportation connectors.
export const OVERTURE_DEMO_TRACE: [number, number][] = [
  ...DEMO_TRACE.slice(0, 5),
  ...DEMO_TRACE.slice(6),
];

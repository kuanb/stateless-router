# stateless-router

Browser-only experiments in map matching directly against remote PMTiles
archives. The original app range-fetches Protomaps z15 road geometry. A separate
Overture graph mode range-fetches z14 transportation segments and connectors.

It builds an ephemeral geometry graph from the fetched road lines to infer
short connectors between direct matches. That graph is deliberately kept
separate from authoritative routing: there is no turn-restriction handling or
legal-route guarantee. The demo is for testing how far geometry-only matching
can go before a graph-specific archive is necessary.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite. Load the included downtown Oakland trace,
or click points onto the map, and choose **Call matcher API**.

The project index is at `/`; the original map is at `/map-match-v1/`; the
Overture graph map is at `/map-match-overture-v1/`; and their page-backed
endpoints are at `/map-match-api-v1/` and `/map-match-api-overture-v1/`.
The lightweight original try-it page remains at `/run-map-match/`. The included
examples and initial map view are centered on downtown Oakland.

## Overture transportation graph mode

The Overture page is intentionally separate so existing links and blog embeds
continue to use the original Protomaps matcher. It reads the official Overture
transportation PMTiles release and decodes the `segment` and `connector` layers.

Unlike the original geometry-derived graph, this mode:

1. Splits transportation segments at their declared connector references.
2. Returns direct edges with their Overture segment ID and connector nodes.
3. Uses network distance while choosing the Viterbi candidate sequence.
4. Routes missing spans only through shared connector IDs.
5. Enforces unconditional directional access restrictions.

The response marks these edges with `topology: "overture_connectors"` and
inferred spans with `confidence: "overture_topology"`. Fully resolved traces set
`route.connectivityVerified` to `true`. Conditional access rules and
`prohibited_transitions` are present in the tiles but are not yet evaluated, so
this remains an experimental matcher rather than a production turn-by-turn
router. The public archive URL is pinned to a dated Overture release and should
be advanced when the published tile release changes.

## What happens in the browser

1. The trace and search radius are converted into a set of z15 tile addresses.
2. `pmtiles` resolves those addresses to byte ranges in the remote archive.
3. `@mapbox/vector-tile` decodes only the selected Protomaps `roads` layers.
4. Each observation gets distance- and heading-scored road candidates.
5. A Viterbi-style dynamic program penalizes implausible distance, road,
   direction, and U-turn transitions between successive snaps.
6. A temporary directed graph splits nearby roads at geometric crossings and
   runs shortest paths between successive matched probes. Uncovered portions
   are returned separately as geometry-only inferred connectors.

The blue selected-road overlay is trimmed around its matched positions by
default. This only removes distracting portions of long vector-tile features
from the display—it does not infer intersections or change the matcher. Disable
**Trim display edges** to inspect the original Protomaps feature geometry.

Dashed purple segments are `inferredEdges`: paths needed to connect successive
matches but not directly supported by the matched-probe extent. Disable
**Infill route gaps** to return only direct matches. This post-match routing is
preferable to inserting straight-line synthetic probes every 10 metres, which
can cut corners and snap onto roads the vehicle never used.

## Page-backed API

The visual map no longer invokes the matcher directly. It loads
`/map-match-api-v1/` in a hidden iframe and exchanges versioned messages using
`window.postMessage`. The endpoint page owns the PMTiles reads, candidate
matching, cache, and response serialization, so the same page can be embedded
by another frontend without an application server.

Requests use this shape:

```json
{
  "coordinates": [[-122.2727, 37.8009], [-122.27115, 37.8044]],
  "options": {
    "radiusMeters": 70,
    "candidateCount": 6,
    "sequenceAware": true,
    "edgePaddingMeters": 0,
    "inferRoute": true
  }
}
```

Responses identify `probes`, direct-match `edges`, `inferredEdges`, and `nodes`,
plus GeoJSON `render.edges`,
`render.inferredEdges`, and `render.matches` FeatureCollections. Every direct
and inferred edge has explicit `startNode` and `endNode` fields. In the original
Protomaps response, nodes are
labeled as `fragment_endpoint` or `inferred_route_endpoint`, always with
`intersectionInferred: false`: they are stable output endpoints, not a claim
that the basemap contains authoritative routing topology.

The response also includes the direct `route.edgeSequence`, ordered
`route.inferredEdgeSequence`, per-probe-pair `route.transitions`, total inferred
distance, and a `MultiLineString` route geometry. `route.connectivityInferred`
reports whether every transition found a path. `route.connectivityVerified`
remains `false` because this graph is derived from cartographic geometry rather
than authoritative routing topology.

An embedding page sends this message to the endpoint iframe:

```js
iframe.contentWindow.postMessage(
  {
    type: "stateless-router:match:v1",
    id: "request-1",
    request: { coordinates, options },
  },
  new URL(iframe.src).origin,
);
```

The endpoint replies with `stateless-router:progress:v1`, followed by either
`stateless-router:response:v1` or `stateless-router:error:v1` using the same
request ID. Because this is a static page protocol rather than an HTTP server,
it is consumed through an iframe—not with `curl` or a server-side POST.

For interactive testing, `/run-map-match/` accepts a coordinate array in its
textarea. Short traces can also be passed as a URL-encoded JSON array in the
`coordinates` query parameter; the page runs them automatically and shows the
response. This is a shareable browser execution URL, not a dynamic HTTP JSON
endpoint.

This is HMM-shaped rather than a calibrated probabilistic HMM: its emission and
transition values are hand-tuned costs. One-way candidates use the direction of
the Protomaps line geometry (including `oneway=-1` reversal); two-way candidates
choose the travel direction closest to the observed trace heading.

The default source is the public Protomaps v4 mirror on Source Cooperative. It
is suitable for this low-volume local experiment; host your own PMTiles archive
or extract for production use.

## GitHub Pages

Pushes to `main` build and deploy the project using
`.github/workflows/deploy-pages.yml`. The workflow runs the tests, builds both
matcher variants and endpoints, and publishes `dist/` as a GitHub Pages artifact.

## Commands

```bash
npm run typecheck
npm test
npm run build
```

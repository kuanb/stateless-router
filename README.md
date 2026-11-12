# stateless-router

A browser-only experiment in map matching directly against a remote Protomaps
PMTiles archive. The app range-fetches z15 vector tiles around a trace, decodes
the `roads` layer, generates nearby road candidates, and chooses a locally
consistent sequence of snaps.

It intentionally does **not** pretend the cartographic tiles are a routing
graph. There is no reconstructed connectivity, turn restriction handling, or
legal-route guarantee. The demo is for testing how far geometry-only matching
can go before a graph-specific archive is necessary.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite. Load the included downtown Oakland trace,
or click points onto the map, and choose **Call matcher API**.

The project index is at `/`; the map is at `/map-match-v1/`; the lightweight
try-it page is at `/run-map-match/`; and the detailed contract console/page
endpoint is at `/map-match-api-v1/`. The included example and initial map view
are centered on downtown Oakland.

## What happens in the browser

1. The trace and search radius are converted into a set of z15 tile addresses.
2. `pmtiles` resolves those addresses to byte ranges in the remote archive.
3. `@mapbox/vector-tile` decodes only the selected Protomaps `roads` layers.
4. Each observation gets distance- and heading-scored road candidates.
5. A Viterbi-style dynamic program penalizes implausible distance, road,
   direction, and U-turn transitions between successive snaps.

The blue selected-road overlay is trimmed around its matched positions by
default. This only removes distracting portions of long vector-tile features
from the display—it does not infer intersections or change the matcher. Disable
**Trim display edges** to inspect the original Protomaps feature geometry.

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
    "edgePaddingMeters": 0
  }
}
```

Responses identify `probes`, `edges`, and `nodes`, plus GeoJSON
`render.edges` and `render.matches` FeatureCollections. Each edge has explicit
`startNode` and `endNode` fields. Those nodes are deliberately labeled
`fragment_endpoint` with `intersectionInferred: false`: they are stable output
endpoints, not a claim that the basemap contains routing topology.

The response also includes `route.edgeSequence`, an ordered, de-duplicated list
of selected edge IDs. `route.connectivityVerified` remains `false` because the
basemap geometry has not been promoted into a routing graph.

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
HTML entry points, and publishes `dist/` as a GitHub Pages artifact.

## Commands

```bash
npm run typecheck
npm test
npm run build
```

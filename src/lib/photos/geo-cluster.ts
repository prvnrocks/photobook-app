// Milestone 2 (T7): single-linkage GPS clustering so we geocode once per ~1 km cluster.
// Pure module. O(n²) neighbour search — fine for ≤500 photos per book.

export type LatLng = { lat: number; lng: number };
export type GeoPoint = LatLng & { id: string };
export type GeoCluster = { centroid: LatLng; ids: string[] };

const EARTH_RADIUS_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Single-linkage clustering: points are connected if within radiusKm; clusters are
 * connected components (BFS). Deterministic: input is sorted by id first, clusters are
 * ordered by their smallest id, ids inside a cluster are sorted. Invalid coords are skipped.
 * Centroid = arithmetic mean of lat/lng (fine at city scale, not across the antimeridian).
 */
export function clusterPoints(points: GeoPoint[], radiusKm = 1): GeoCluster[] {
  const pts = points
    .filter(
      (p) =>
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        Math.abs(p.lat) <= 90 &&
        Math.abs(p.lng) <= 180,
    )
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Array<boolean>(pts.length).fill(false);
  const clusters: GeoCluster[] = [];

  for (let s = 0; s < pts.length; s++) {
    if (seen[s]) continue;
    seen[s] = true;
    const queue = [s];
    const members: number[] = [];
    while (queue.length) {
      const i = queue.shift() as number;
      members.push(i);
      for (let j = 0; j < pts.length; j++) {
        if (!seen[j] && haversineKm(pts[i], pts[j]) <= radiusKm) {
          seen[j] = true;
          queue.push(j);
        }
      }
    }
    members.sort((a, b) => a - b);
    let lat = 0;
    let lng = 0;
    for (const i of members) {
      lat += pts[i].lat;
      lng += pts[i].lng;
    }
    clusters.push({
      centroid: { lat: lat / members.length, lng: lng / members.length },
      ids: members.map((i) => pts[i].id),
    });
  }
  return clusters;
}

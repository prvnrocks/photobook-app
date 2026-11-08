// Milestone 2 (T7): single-linkage GPS clustering so we geocode once per ~1 km cluster.
// Components wider than MAX_CLUSTER_SPAN_KM (e.g. a road trip chained by photos every
// few hundred metres) are split again by greedy seeding (review N8), so one label never
// stands for a 50 km stretch. Pure, deterministic. O(n²) — fine for ≤500 photos per book.

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

/** Max distance between any two points of one cluster before it is split. */
export const MAX_CLUSTER_SPAN_KM = 5;

/**
 * Splits one over-wide component: repeatedly take the unassigned point with the most
 * unassigned neighbours within radiusKm (ties → lowest index, i.e. smallest id) and make
 * it + those neighbours a cluster. Every resulting cluster spans ≤ 2 × radiusKm.
 */
function splitBySeeds(members: number[], dist: (a: number, b: number) => number, radiusKm: number): number[][] {
  const near = members.map((i) => members.filter((j) => dist(i, j) <= radiusKm));
  const assigned = new Set<number>();
  const groups: number[][] = [];
  while (assigned.size < members.length) {
    let best = -1;
    let bestCount = -1;
    for (let k = 0; k < members.length; k++) {
      if (assigned.has(members[k])) continue;
      let count = 0;
      for (const j of near[k]) if (!assigned.has(j)) count++;
      if (count > bestCount) {
        best = k;
        bestCount = count;
      }
    }
    const group = near[best].filter((j) => !assigned.has(j)).sort((a, b) => a - b);
    for (const j of group) assigned.add(j);
    groups.push(group);
  }
  return groups;
}

/**
 * Single-linkage clustering: points are connected if within radiusKm; clusters are
 * connected components (BFS). A component whose max pairwise distance exceeds maxSpanKm
 * is split by greedy seeding (see splitBySeeds). Deterministic: input is sorted by id
 * first, clusters are ordered by their smallest id, ids inside a cluster are sorted.
 * Invalid coords are skipped.
 * Centroid = arithmetic mean of lat/lng (fine at city scale, not across the antimeridian).
 */
export function clusterPoints(
  points: GeoPoint[],
  radiusKm = 1,
  maxSpanKm = MAX_CLUSTER_SPAN_KM,
): GeoCluster[] {
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
  const groups: number[][] = [];
  const dist = (a: number, b: number) => haversineKm(pts[a], pts[b]);

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
    let span = 0;
    for (let x = 0; x < members.length && span <= maxSpanKm; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const d = dist(members[x], members[y]);
        if (d > span) span = d;
        if (span > maxSpanKm) break;
      }
    }
    if (span > maxSpanKm) groups.push(...splitBySeeds(members, dist, radiusKm));
    else groups.push(members);
  }

  groups.sort((a, b) => a[0] - b[0]);
  return groups.map((members) => {
    let lat = 0;
    let lng = 0;
    for (const i of members) {
      lat += pts[i].lat;
      lng += pts[i].lng;
    }
    return {
      centroid: { lat: lat / members.length, lng: lng / members.length },
      ids: members.map((i) => pts[i].id),
    };
  });
}

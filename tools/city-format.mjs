// Binary city geometry format shared by the build tool and the browser loader.
//
//   'CAC1'                        magic
//   u32 buildingCount, u32 roadCount
//   f32 centreLat, f32 centreLon, f32 extentM
//   buildings: u16 vertexCount, f32 heightM, vertexCount x (i16 x, i16 y) in decimetres, x east, y north
//   roads:     u8 class, u16 vertexCount, vertexCount x (i16 x, i16 y)
export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'other'];

export function encodeCity({ lat, lon, extentM, buildings, roads }) {
  let size = 4 + 8 + 12;
  for (const b of buildings) size += 2 + 4 + b.verts.length * 2;
  for (const r of roads) size += 1 + 2 + r.verts.length * 2;
  const buf = new ArrayBuffer(size), dv = new DataView(buf);
  let o = 0;
  for (const ch of 'CAC1') dv.setUint8(o++, ch.charCodeAt(0));
  dv.setUint32(o, buildings.length, true); o += 4; dv.setUint32(o, roads.length, true); o += 4;
  dv.setFloat32(o, lat, true); o += 4; dv.setFloat32(o, lon, true); o += 4; dv.setFloat32(o, extentM, true); o += 4;
  const dm = (v) => Math.max(-32767, Math.min(32767, Math.round(v * 10)));
  for (const b of buildings) {
    dv.setUint16(o, b.verts.length / 2, true); o += 2; dv.setFloat32(o, b.height, true); o += 4;
    for (let i = 0; i < b.verts.length; i++) { dv.setInt16(o, dm(b.verts[i]), true); o += 2; }
  }
  for (const r of roads) {
    dv.setUint8(o++, r.cls); dv.setUint16(o, r.verts.length / 2, true); o += 2;
    for (let i = 0; i < r.verts.length; i++) { dv.setInt16(o, dm(r.verts[i]), true); o += 2; }
  }
  return buf;
}

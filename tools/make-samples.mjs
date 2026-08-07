/**
 * Write one small, valid sample per format that had no test file.
 *
 * The formats below are handled by three.js loaders, so what needs proving is
 * the dispatch, the material wiring and the statistics, not the parsers
 * themselves. A unit cube and a point cloud are enough for that, and they are
 * written here rather than downloaded so the check stays reproducible offline.
 *
 *   node tools/make-samples.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zipSync, strToU8 } from "three/examples/jsm/libs/fflate.module.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "fmt");
mkdirSync(out, { recursive: true });

const write = (name, data) => {
  writeFileSync(join(out, name), data);
  console.log(`${name}  ${data.length} bytes`);
};

// --- the shared cube ------------------------------------------------------

const H = 0.5;
const POS = [
  [-H, -H, -H], [H, -H, -H], [H, H, -H], [-H, H, -H],
  [-H, -H, H], [H, -H, H], [H, H, H], [-H, H, H],
];
// Counter clockwise seen from outside, so face normals point out.
const TRI = [
  [4, 5, 6], [4, 6, 7], [1, 0, 3], [1, 3, 2],
  [0, 4, 7], [0, 7, 3], [5, 1, 2], [5, 2, 6],
  [3, 7, 6], [3, 6, 2], [0, 1, 5], [0, 5, 4],
];
// A colour per corner, so vertex colours are visibly either used or dropped.
const RGB = POS.map(([x, y, z]) => [
  Math.round((x + H) * 255), Math.round((y + H) * 255), Math.round((z + H) * 255),
]);

// --- PLY, ascii and binary ------------------------------------------------

const plyHeader = (format) => [
  "ply",
  `format ${format} 1.0`,
  "comment Albedo test cube",
  `element vertex ${POS.length}`,
  "property float x", "property float y", "property float z",
  "property uchar red", "property uchar green", "property uchar blue",
  `element face ${TRI.length}`,
  "property list uchar int vertex_index",
  "end_header",
  "",
].join("\n");

write(
  "cube.ply",
  plyHeader("ascii 1.0").replace(" 1.0 1.0", " 1.0") +
    POS.map((p, i) => `${p.join(" ")} ${RGB[i].join(" ")}`).join("\n") +
    "\n" +
    TRI.map((t) => `3 ${t.join(" ")}`).join("\n") +
    "\n"
);

{
  const header = Buffer.from(plyHeader("binary_little_endian"), "ascii");
  const body = Buffer.alloc(POS.length * 15 + TRI.length * 13);
  let o = 0;
  POS.forEach((p, i) => {
    body.writeFloatLE(p[0], o); body.writeFloatLE(p[1], o + 4); body.writeFloatLE(p[2], o + 8);
    body[o + 12] = RGB[i][0]; body[o + 13] = RGB[i][1]; body[o + 14] = RGB[i][2];
    o += 15;
  });
  for (const t of TRI) {
    body[o] = 3; o += 1;
    for (const v of t) { body.writeInt32LE(v, o); o += 4; }
  }
  write("cube-binary.ply", Buffer.concat([header, body]));
}

// --- Collada --------------------------------------------------------------

write(
  "cube.dae",
  `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><up_axis>Y_UP</up_axis><unit meter="1" name="meter"/></asset>
  <library_effects>
    <effect id="clay-fx">
      <profile_COMMON><technique sid="common"><lambert>
        <diffuse><color>0.78 0.36 0.22 1</color></diffuse>
      </lambert></technique></profile_COMMON>
    </effect>
  </library_effects>
  <library_materials>
    <material id="clay" name="clay"><instance_effect url="#clay-fx"/></material>
  </library_materials>
  <library_geometries>
    <geometry id="cube-geo" name="cube">
      <mesh>
        <source id="cube-pos">
          <float_array id="cube-pos-array" count="${POS.length * 3}">${POS.flat().join(" ")}</float_array>
          <technique_common>
            <accessor source="#cube-pos-array" count="${POS.length}" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="cube-vtx"><input semantic="POSITION" source="#cube-pos"/></vertices>
        <triangles count="${TRI.length}" material="clay-symbol">
          <input semantic="VERTEX" source="#cube-vtx" offset="0"/>
          <p>${TRI.flat().join(" ")}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="scene" name="scene">
      <node id="cube-node" name="cube" type="NODE">
        <instance_geometry url="#cube-geo">
          <bind_material><technique_common>
            <instance_material symbol="clay-symbol" target="#clay"/>
          </technique_common></bind_material>
        </instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
`
);

// --- 3MF, an OPC package --------------------------------------------------

{
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model" name="cube">
   <mesh>
    <vertices>
${POS.map(([x, y, z]) => `     <vertex x="${x * 10}" y="${y * 10}" z="${z * 10}"/>`).join("\n")}
    </vertices>
    <triangles>
${TRI.map(([a, b, c]) => `     <triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("\n")}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build><item objectid="1"/></build>
</model>
`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  write(
    "cube.3mf",
    Buffer.from(
      zipSync({
        "[Content_Types].xml": strToU8(contentTypes),
        "_rels/.rels": strToU8(rels),
        "3D/3dmodel.model": strToU8(model),
      })
    )
  );
}

// --- 3DS, chunked binary --------------------------------------------------

{
  const chunk = (id, content, children = []) => {
    const body = Buffer.concat([content, ...children]);
    const head = Buffer.alloc(6);
    head.writeUInt16LE(id, 0);
    head.writeUInt32LE(6 + body.length, 2);
    return Buffer.concat([head, body]);
  };
  const name = Buffer.from("cube\0", "ascii");

  const vertices = Buffer.alloc(2 + POS.length * 12);
  vertices.writeUInt16LE(POS.length, 0);
  POS.forEach(([x, y, z], i) => {
    const o = 2 + i * 12;
    // 3ds is Z up, so the axes are swapped here rather than at load time
    vertices.writeFloatLE(x, o);
    vertices.writeFloatLE(-z, o + 4);
    vertices.writeFloatLE(y, o + 8);
  });

  const faces = Buffer.alloc(2 + TRI.length * 8);
  faces.writeUInt16LE(TRI.length, 0);
  TRI.forEach(([a, b, c], i) => {
    const o = 2 + i * 8;
    faces.writeUInt16LE(a, o);
    faces.writeUInt16LE(b, o + 2);
    faces.writeUInt16LE(c, o + 4);
    faces.writeUInt16LE(7, o + 6); // all three edges visible
  });

  const trimesh = chunk(0x4100, Buffer.alloc(0), [chunk(0x4110, vertices), chunk(0x4120, faces)]);
  const object = chunk(0x4000, name, [trimesh]);
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const editor = chunk(0x3d3d, Buffer.alloc(0), [chunk(0x3d3e, version), object]);
  const meshVersion = Buffer.alloc(4);
  meshVersion.writeUInt32LE(3, 0);
  write("cube.3ds", chunk(0x4d4d, Buffer.alloc(0), [chunk(0x0002, meshVersion), editor]));
}

// --- VRML 2.0 -------------------------------------------------------------

write(
  "cube.wrl",
  `#VRML V2.0 utf8
# Albedo test cube

Shape {
  appearance Appearance {
    material Material {
      diffuseColor 0.75 0.4 0.25
      specularColor 0.2 0.2 0.2
    }
  }
  geometry IndexedFaceSet {
    coord Coordinate {
      point [
${POS.map(([x, y, z]) => `        ${x} ${y} ${z},`).join("\n")}
      ]
    }
    color Color {
      color [
${RGB.map(([r, g, b]) => `        ${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)},`).join("\n")}
      ]
    }
    colorPerVertex TRUE
    coordIndex [
${TRI.map((t) => `      ${t.join(", ")}, -1,`).join("\n")}
    ]
    solid TRUE
  }
}
`
);

// --- MagicaVoxel ----------------------------------------------------------

{
  const voxChunk = (id, content, children = Buffer.alloc(0)) => {
    const head = Buffer.alloc(12);
    head.write(id, 0, 4, "ascii");
    head.writeUInt32LE(content.length, 4);
    head.writeUInt32LE(children.length, 8);
    return Buffer.concat([head, content, children]);
  };

  const N = 6;
  const voxels = [];
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
      for (let z = 0; z < N; z++) {
        // hollow shell, so the model is not one solid block of identical cubes
        const edge = x === 0 || y === 0 || z === 0 || x === N - 1 || y === N - 1 || z === N - 1;
        if (edge) voxels.push([x, y, z, 1 + ((x + y + z) % 8)]);
      }

  const size = Buffer.alloc(12);
  size.writeUInt32LE(N, 0); size.writeUInt32LE(N, 4); size.writeUInt32LE(N, 8);

  const xyzi = Buffer.alloc(4 + voxels.length * 4);
  xyzi.writeUInt32LE(voxels.length, 0);
  voxels.forEach(([x, y, z, c], i) => {
    const o = 4 + i * 4;
    xyzi[o] = x; xyzi[o + 1] = y; xyzi[o + 2] = z; xyzi[o + 3] = c;
  });

  const header = Buffer.alloc(8);
  header.write("VOX ", 0, 4, "ascii");
  header.writeUInt32LE(150, 4);
  const children = Buffer.concat([voxChunk("SIZE", size), voxChunk("XYZI", xyzi)]);
  write("cube.vox", Buffer.concat([header, voxChunk("MAIN", Buffer.alloc(0), children)]));
}

// --- AMF, plain XML -------------------------------------------------------

write(
  "cube.amf",
  `<?xml version="1.0" encoding="UTF-8"?>
<amf unit="millimeter" version="1.1">
 <object id="1">
  <mesh>
   <vertices>
${POS.map(([x, y, z]) => `    <vertex><coordinates><x>${x * 10}</x><y>${y * 10}</y><z>${z * 10}</z></coordinates></vertex>`).join("\n")}
   </vertices>
   <volume>
${TRI.map(([a, b, c]) => `    <triangle><v1>${a}</v1><v2>${b}</v2><v3>${c}</v3></triangle>`).join("\n")}
   </volume>
  </mesh>
 </object>
 <constellation id="2"><instance objectid="1"><deltax>0</deltax><deltay>0</deltay><deltaz>0</deltaz></instance></constellation>
</amf>
`
);

// --- point clouds ---------------------------------------------------------

// A Fibonacci sphere: evenly spread, and a wrong axis order is obvious.
const CLOUD = [];
{
  const count = 2000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i;
    CLOUD.push([Math.cos(a) * r, y * 1.5, Math.sin(a) * r]);
  }
}

write(
  "sphere.pcd",
  `# .PCD v0.7 - Point Cloud Data file format
VERSION 0.7
FIELDS x y z
SIZE 4 4 4
TYPE F F F
COUNT 1 1 1
WIDTH ${CLOUD.length}
HEIGHT 1
VIEWPOINT 0 0 0 1 0 0 0
POINTS ${CLOUD.length}
DATA ascii
${CLOUD.map(([x, y, z]) => `${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`).join("\n")}
`
);

write(
  "sphere.xyz",
  CLOUD.map(([x, y, z]) =>
    `${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)} ` +
    `${((x + 1) / 2).toFixed(3)} ${(y / 3 + 0.5).toFixed(3)} ${((z + 1) / 2).toFixed(3)}`
  ).join("\n") + "\n"
);

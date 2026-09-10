import { cpSync, mkdirSync } from "node:fs";
// File managers render offline and often without network permission.
for (const name of ["draco", "basis"]) {
  mkdirSync(`public/codecs/${name}`, { recursive: true });
  cpSync(`node_modules/three/examples/jsm/libs/${name}`, `public/codecs/${name}`, { recursive: true });
}

/**
 * The icon set for the Retopo bar.
 *
 * Inline SVG rather than a font or a sprite sheet, for the reason that decides
 * it here: this module is a lazy chunk in an executable that is also the Explorer
 * thumbnail provider, one process per file. A font is a network request and a
 * sprite is a second file; a string is neither.
 *
 * **Each one carries a colour of its own.** A row of fifteen monochrome glyphs
 * is a row of fifteen things you have to read, and reading them is exactly what
 * an icon is supposed to spare you. The colours are not decoration: they are the
 * thing that lets you hit "UV" without checking the tooltip, and they are picked
 * to say something about the mode rather than to be pretty. Normals get the red,
 * green and blue that a normal map is literally made of. Deviation gets its own
 * heat ramp. The atlas gets four different hues because that is what charts look
 * like on screen.
 *
 * Two rules kept throughout: 16 by 16 on a `0 0 16 16` box so they line up
 * without per icon nudging, and `stroke-width: 1.4` so they hold at the small
 * size the bar actually uses them at.
 */

const wrap = (body, extra = "") =>
  `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" ` +
  `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

export const ICONS = {
  // --- display channels ---

  /** Shaded: a lit sphere, the terminator drawn rather than implied. */
  shaded: wrap(
    `<circle cx="8" cy="8" r="5.6"/>
     <path d="M8 2.4a5.6 5.6 0 0 0 0 11.2" fill="currentColor" stroke="none" opacity="0.55"/>`
  ),

  /** Painted: a brush, for the texture as it was authored. */
  unlit: wrap(
    `<path d="M11.6 2.6 13.4 4.4 7.6 10.2 5.8 8.4z" stroke="#ffb454"/>
     <path d="M5.8 8.4 4 12.9l4.5-1.8" stroke="#ffb454"/>`
  ),

  /** Base colour: overlapping swatches, because that is all albedo is. */
  albedo: wrap(
    `<circle cx="6.3" cy="6.6" r="3.6" stroke="#ff6b6b"/>
     <circle cx="9.7" cy="9.4" r="3.6" stroke="#4dd0e1"/>`
  ),

  /** Normals: the three axes in the three colours a normal map encodes them in. */
  normalGeom: wrap(
    `<path d="M8 8V2.6" stroke="#5ec269"/>
     <path d="M8 8 3.2 10.8" stroke="#e05a5a"/>
     <path d="M8 8l4.8 2.8" stroke="#5b8def"/>
     <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/>`
  ),

  /** UV: the checker, with two squares filled so it reads at 15 pixels. */
  uv: wrap(
    `<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1"/>
     <rect x="2.6" y="2.6" width="5.4" height="5.4" fill="#7cc4ff" stroke="none" opacity="0.75"/>
     <rect x="8" y="8" width="5.4" height="5.4" fill="#7cc4ff" stroke="none" opacity="0.75"/>`
  ),

  /** Charts: four islands in four hues, which is what an atlas looks like. */
  charts: wrap(
    `<path d="M2.6 2.6h4.6v4.6H2.6z" stroke="#ff8fa3"/>
     <path d="M8.8 2.6h4.6v3H8.8z" stroke="#8fd694"/>
     <path d="M2.6 8.8h3v4.6h-3z" stroke="#ffd479"/>
     <path d="M7.2 7.2h6.2v6.2H7.2z" stroke="#9db8ff"/>`
  ),

  /** Deviation: the heat ramp itself, cold to hot, left to right. */
  deviation: wrap(
    `<rect x="2.4" y="5.4" width="11.2" height="5.2" rx="1" stroke="none" fill="url(#rtHeat)"/>
     <rect x="2.4" y="5.4" width="11.2" height="5.2" rx="1"/>
     <defs><linearGradient id="rtHeat" x1="0" x2="1">
       <stop offset="0" stop-color="#1a3390"/><stop offset="0.35" stop-color="#1ab3bf"/>
       <stop offset="0.6" stop-color="#8cd93f"/><stop offset="0.8" stop-color="#fab81a"/>
       <stop offset="1" stop-color="#eb2920"/>
     </linearGradient></defs>`
  ),

  // --- edges ---

  /** No edges: the mesh icon with its lines struck out. */
  wireOff: wrap(
    `<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" opacity="0.45"/>
     <path d="M3.4 12.6 12.6 3.4" stroke="#8b929c"/>`
  ),
  /** Dark edges, for a light model. */
  wireDark: wrap(
    `<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" fill="#d7dbe2" stroke="#d7dbe2"/>
     <path d="M8 2.6v10.8M2.6 8h10.8" stroke="#15171b"/>`
  ),
  /** Light edges, for a dark model, which is most of them. */
  wireLight: wrap(
    `<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" fill="#23262c" stroke="#3a3f48"/>
     <path d="M8 2.6v10.8M2.6 8h10.8" stroke="#ffffff"/>`
  ),

  /** Flat shading: a faceted solid, the facets drawn. */
  flat: wrap(
    `<path d="M8 2.2 13.6 6v6.2L8 14.4 2.4 12.2V6z"/>
     <path d="M8 2.2v12.2M2.4 6l5.6 2.6L13.6 6" opacity="0.7"/>`
  ),

  /** X-ray: see the far side through the near one. */
  xray: wrap(
    `<path d="M8 2.2 13.6 6v6.2L8 14.4 2.4 12.2V6z" opacity="0.5"/>
     <path d="M8 8.6 13.6 6M8 8.6 2.4 6M8 8.6v5.8" stroke="#7cc4ff" stroke-dasharray="1.6 1.4"/>`
  ),

  // --- comparison ---

  /** Source alone. */
  cmpSource: wrap(`<circle cx="8" cy="8" r="5" stroke="#8b929c"/>`),
  /** Result alone. */
  cmpResult: wrap(`<circle cx="8" cy="8" r="5" stroke="#9ede4f"/>`),
  /** Both in the scene. */
  cmpBoth: wrap(
    `<circle cx="6.2" cy="8" r="4.2" stroke="#8b929c"/>
     <circle cx="9.8" cy="8" r="4.2" stroke="#9ede4f"/>`
  ),
  /** The curtain: one square cut down the middle, each half a different side. */
  cmpSplit: wrap(
    `<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1"/>
     <path d="M8 3.4v9.2" stroke="#7cc4ff"/>
     <rect x="2.6" y="3.4" width="5.4" height="9.2" fill="#8b929c" stroke="none" opacity="0.35"/>`
  ),
  /** The ghost: a solid with a translucent shell over it. */
  cmpGhost: wrap(
    `<circle cx="8" cy="8" r="3" fill="#9ede4f" stroke="none" opacity="0.85"/>
     <circle cx="8" cy="8" r="5.4" stroke="#4dd0e1" stroke-dasharray="1.8 1.6"/>`
  ),

  /** Frame the model. */
  frame: wrap(
    `<path d="M2.6 5.6V2.6h3M10.4 2.6h3v3M13.4 10.4v3h-3M5.6 13.4h-3v-3"/>
     <circle cx="8" cy="8" r="1.8" opacity="0.8"/>`
  ),

  /** Undo and redo, for the result history. */
  undo: wrap(`<path d="M6.4 4.2 3 7.6l3.4 3.4"/><path d="M3 7.6h6.2a3.8 3.8 0 0 1 0 7.6H7.6"/>`),
  redo: wrap(`<path d="M9.6 4.2 13 7.6l-3.4 3.4"/><path d="M13 7.6H6.8a3.8 3.8 0 0 0 0 7.6h1.6"/>`),
};

import { registerCustomFonts } from '@excalidraw/excalidraw'

// These IDs are saved in board scenes. Never renumber or reuse them.
// Helvetica retains Excalidraw's existing ID (2) for saved-board compatibility.
export const WHITEBOARD_FONTS = [
  {
    id: 2000,
    family: 'Arial',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1854,
      descender: -434,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'sans-serif',
    local: true,
  },
  {
    id: 2001,
    family: 'Times New Roman',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1825,
      descender: -443,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'serif',
    local: true,
  },
  {
    id: 2,
    family: 'Helvetica',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1577,
      descender: -471,
      lineHeight: 1.15,
    },
    uri: 'local:',
    genericFamily: 'sans-serif',
    local: true,
  },
  {
    id: 2003,
    family: 'Verdana',
    metrics: {
      unitsPerEm: 2048,
      ascender: 2059,
      descender: -430,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'sans-serif',
    local: true,
  },
  {
    id: 2004,
    family: 'Georgia',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1878,
      descender: -449,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'serif',
    local: true,
  },
  {
    id: 2005,
    family: 'Courier New',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1705,
      descender: -615,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'monospace',
    local: true,
  },
  {
    id: 2006,
    family: 'Trebuchet MS',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1923,
      descender: -455,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'sans-serif',
    local: true,
  },
  {
    id: 2007,
    family: 'Tahoma',
    metrics: {
      unitsPerEm: 2048,
      ascender: 2049,
      descender: -423,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'sans-serif',
    local: true,
  },
  {
    id: 2008,
    family: 'Segoe UI',
    metrics: {
      unitsPerEm: 2048,
      ascender: 2210,
      descender: -514,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'sans-serif',
    local: true,
  },
  {
    id: 2009,
    family: 'Calibri',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1950,
      descender: -550,
      lineHeight: 1.25,
    },
    uri: 'local:',
    genericFamily: 'sans-serif',
    local: true,
  },
  {
    id: 2010,
    family: 'Roboto',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1900,
      descender: -500,
      lineHeight: 1.35,
    },
    uri: 'roboto.woff2',
    genericFamily: 'sans-serif',
  },
  {
    id: 2011,
    family: 'Open Sans',
    metrics: {
      unitsPerEm: 2048,
      ascender: 2189,
      descender: -600,
      lineHeight: 1.35,
    },
    uri: 'opensans.woff2',
    genericFamily: 'sans-serif',
  },
  {
    id: 2012,
    family: 'Inter',
    metrics: {
      unitsPerEm: 2048,
      ascender: 1984,
      descender: -494,
      lineHeight: 1.35,
    },
    uri: 'inter.woff2',
    genericFamily: 'sans-serif',
  },
  {
    id: 2013,
    family: 'Lato',
    metrics: {
      unitsPerEm: 2000,
      ascender: 1974,
      descender: -426,
      lineHeight: 1.35,
    },
    uri: 'lato.woff2',
    genericFamily: 'sans-serif',
  },
  {
    id: 2014,
    family: 'Montserrat',
    metrics: {
      unitsPerEm: 1000,
      ascender: 968,
      descender: -251,
      lineHeight: 1.35,
    },
    uri: 'montserrat.woff2',
    genericFamily: 'sans-serif',
  },
  {
    id: 2015,
    family: 'Poppins',
    metrics: {
      unitsPerEm: 1000,
      ascender: 1050,
      descender: -350,
      lineHeight: 1.35,
    },
    uri: 'poppins.woff2',
    genericFamily: 'sans-serif',
  },
  {
    id: 2016,
    family: 'Noto Sans',
    metrics: {
      unitsPerEm: 1000,
      ascender: 1069,
      descender: -293,
      lineHeight: 1.35,
    },
    uri: 'notosans.woff2',
    genericFamily: 'sans-serif',
  },
  {
    id: 2017,
    family: 'Merriweather',
    metrics: {
      unitsPerEm: 2000,
      ascender: 1968,
      descender: -546,
      lineHeight: 1.35,
    },
    uri: 'merriweather.woff2',
    genericFamily: 'serif',
  },
  {
    id: 2018,
    family: 'Playfair Display',
    metrics: {
      unitsPerEm: 1000,
      ascender: 1082,
      descender: -251,
      lineHeight: 1.35,
    },
    uri: 'playfairdisplay.woff2',
    genericFamily: 'serif',
  },
  {
    id: 2019,
    family: 'Fira Code',
    metrics: {
      unitsPerEm: 2000,
      ascender: 1980,
      descender: -644,
      lineHeight: 1.35,
    },
    uri: 'firacode.woff2',
    genericFamily: 'monospace',
  },
] as const

let registered = false

export function registerWhiteboardFonts() {
  if (registered) return
  registerCustomFonts(
    WHITEBOARD_FONTS.map((font) => ({
      ...font,
      uri:
        font.uri === 'local:'
          ? font.uri
          : new URL(`${import.meta.env.BASE_URL}fonts/${font.uri}`, window.location.href).href,
    })),
  )
  registered = true
}

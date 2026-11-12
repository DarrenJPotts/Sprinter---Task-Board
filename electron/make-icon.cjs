// Writes electron/tray.png and build-resources/icon.png (the installer and taskbar icon, 256 px): a yellow
// tile with a thick black border and a hard shadow, the board's neubrutalist look. Run: node electron/make-icon.cjs
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SIZE = 32
const pixels = Buffer.alloc(SIZE * SIZE * 4)

function paint(x0, y0, x1, y1, [r, g, b, a]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * SIZE + x) * 4
      pixels[at] = r
      pixels[at + 1] = g
      pixels[at + 2] = b
      pixels[at + 3] = a
    }
  }
}

const black = [0, 0, 0, 255]
paint(5, 5, 32, 32, black) // the hard shadow
paint(1, 1, 28, 28, black) // the border
paint(4, 4, 25, 25, [255, 220, 88, 255]) // the yellow face
// Three bars: a little kanban
paint(7, 8, 11, 21, black)
paint(13, 8, 17, 17, black)
paint(19, 8, 23, 13, black)

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = buf => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// The 32 px design scaled up whole pixels at a time, so the big icon keeps the hard edges.
function png(scale) {
  const size = SIZE * scale
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const rows = Buffer.concat(
    Array.from({ length: size }, (_, y) => {
      const row = Buffer.alloc(1 + size * 4)
      for (let x = 0; x < size; x++) pixels.copy(row, 1 + x * 4, (Math.floor(y / scale) * SIZE + Math.floor(x / scale)) * 4, (Math.floor(y / scale) * SIZE + Math.floor(x / scale)) * 4 + 4)
      return row
    }),
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

writeFileSync(path.join(__dirname, 'tray.png'), png(1))
mkdirSync(path.join(__dirname, '..', 'build-resources'), { recursive: true })
writeFileSync(path.join(__dirname, '..', 'build-resources', 'icon.png'), png(8))
console.log('wrote electron/tray.png and build-resources/icon.png')

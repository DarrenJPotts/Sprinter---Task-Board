// The desktop shell: the same server and UI as `npm start`, in a window of its own.
// From source the server runs under the system Node with tsx; the installed app runs its bundled copy
// under Electron's own Node. node-pty's binary is Node-API, so the same one loads in both.
// Closing the window hides it to the tray, so the ticket terminals keep running;
// Quit in the tray menu ends the app.
const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

const PORT = Number(process.env.SPRINTER_PORT) || 7430
const ROOT = path.join(__dirname, '..')
let server
let win
let tray
let isQuitting = false

function startServer() {
  if (app.isPackaged) {
    // The installed app carries no Node and no tsx, so Electron runs the bundled server as plain Node.
    server = spawn(process.execPath, [path.join(ROOT, 'build', 'server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  server = spawn('node', ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
}

function isUp() {
  return new Promise(resolve =>
    http.get(`http://127.0.0.1:${PORT}/api/snapshot`, res => (res.resume(), resolve(true))).on('error', () => resolve(false)),
  )
}

function whenUp(retries = 60) {
  return new Promise((resolve, reject) => {
    const probe = () =>
      http
        .get(`http://127.0.0.1:${PORT}/api/snapshot`, res => {
          res.resume()
          resolve()
        })
        .on('error', () => (retries-- > 0 ? setTimeout(probe, 500) : reject(new Error('server did not start'))))
    probe()
  })
}

function show() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Sprinter',
    icon: path.join(__dirname, 'tray.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  // ADO links and anything else off the app open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('close', event => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  await whenUp()
  await win.loadURL(`http://localhost:${PORT}`)
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')))
  tray.setToolTip('Sprinter')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Sprinter', click: show },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', show)
  tray.on('double-click', show)
}

// One app at a time: opening it again brings the running window back from the tray.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', show)

  app.whenReady().then(async () => {
    // A server already running (npm start, npm run dev) is used as is; the app starts one only when none is.
    if (!(await isUp())) startServer()
    createTray()
    void createWindow()
  })

  app.on('before-quit', () => {
    isQuitting = true
  })
  // Closing the window only hides it, so the app lives on in the tray until Quit.
  app.on('window-all-closed', () => undefined)
  app.on('quit', () => server?.kill())
}

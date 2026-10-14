// Run with: node_modules/.bin/electron scripts/radio-preview.cjs
const path = require('node:path')
const { app } = require('electron')
app.setName('LX Music Radio')
app.setPath('userData', process.env.LX_RADIO_PROFILE || path.resolve(__dirname, '../.radio-preview'))
app.commandLine.appendSwitch('lx-radio-session')
if (process.argv.includes('--mini-player')) app.commandLine.appendSwitch('lx-radio-mini')
require('../dist/main.js')

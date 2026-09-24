// Some IDE hosts set ELECTRON_RUN_AS_NODE for their own helpers.
// Remove it only from our child process so the desktop app starts as Electron.
const { spawn } = require('node:child_process');
const path = require('node:path');
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  env: childEnv, stdio: 'inherit', windowsHide: true
});
child.on('error', error => { console.error('无法启动桌面应用：' + error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

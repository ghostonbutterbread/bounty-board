// Each Node test worker gets a disposable HOME. Browser fixtures that use
// make_server's production default must never write the operator's config.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-home-'));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.XDG_STATE_HOME = path.join(home, '.local', 'state');
process.on('exit', () => fs.rmSync(home, {recursive: true, force: true}));

// Real Chromium -> Board -> actual BBH writer, on a disposable synthetic root.
// Usage: BBH_SNAPSHOT=/path/to/bbh-with-bounty_core TMPDIR=/scratch node tests/ledger_actions_bbh_e2e.cjs
// BBH_SNAPSHOT is copied into a fresh directory under TMPDIR; the copy, the
// root and HOME all live under TMPDIR. Never point this at a real root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

async function main() {
  const tmp = fs.realpathSync(process.env.TMPDIR || '');
  assert(process.env.TMPDIR && tmp !== '/' && tmp === fs.realpathSync(os.tmpdir()), 'set TMPDIR to a disposable scratch directory');
  assert(process.env.BBH_SNAPSHOT && fs.existsSync(path.join(process.env.BBH_SNAPSHOT, 'bounty_core')), 'BBH_SNAPSHOT must contain bounty_core');
  const work = fs.mkdtempSync(path.join(tmp, 'ledger-bbh-e2e-'));
  const home = path.join(work, 'home'), root = path.join(work, 'synthetic-root'), bbhDir = path.join(work, 'bbh');
  fs.mkdirSync(home); fs.mkdirSync(root);
  fs.cpSync(process.env.BBH_SNAPSHOT, bbhDir, {recursive: true, verbatimSymlinks: true});
  const bbh = path.join(bbhDir, 'scripts/bbh'), marker = path.join(work, 'board-writes');
  const env = {...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), BBH_SKIP_DEP_CHECK: '1'};
  const run = (...args) => { const p = spawnSync(bbh, args, {encoding: 'utf8', timeout: 60000, env}); assert.equal(p.status, 0, `${args.join(' ')}\n${p.stdout}\n${p.stderr}`); return p.stdout; };
  const base = ['fictional.example', '--family', 'web_bounty', '--lane', 'web', '--root', root];
  const notes = [
    'Title: Synthetic stored note\nClass: xss\nSeverity: LOW\nFile: /notes\nDescription: Fixture only.\n',
    'Title: Synthetic object access\nClass: idor\nSeverity: informational\nFile: /items\nDescription: Fixture only.\n',
    'Title: Synthetic fetch\nClass: ssrf\nSeverity: HIGH\nFile: /fetch\nDescription: Fixture only.\n',
  ];
  notes.forEach((note, i) => { fs.writeFileSync(path.join(work, `note${i}.md`), note); run('agents/manual_hunter.py', ...base, '--from-file', path.join(work, `note${i}.md`)); });
  const lane = path.join(root, 'web_bounty/fictional.example/web');
  const ledger = () => JSON.parse(fs.readFileSync(path.join(lane, 'ledgers/ledger.json'), 'utf8')).findings;
  const byTitle = title => ledger().find(f => f.title === title);
  const mapPath = path.join(lane, 'recon/maps/map.jsonl');
  const mapEntries = () => fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  assert.equal(byTitle('Synthetic object access').severity, 'INFO', 'BBH stores informational as INFO');
  const evidence = byTitle('Synthetic fetch').evidence_path; assert(fs.existsSync(evidence));
  const writer = path.join(work, 'writer');
  fs.writeFileSync(writer, `#!/bin/sh\ncase " $* " in *" --help "*) ;; *) printf '%s\\n' "$1" >> '${marker}';; esac\nexec '${bbh}' "$@"\n`, {mode: 0o700});
  const code = `import app; s=app.make_server(${JSON.stringify(root)},0,writer=${JSON.stringify(writer)},accept_uncoordinated_writes=True); print(s.server_port,flush=True); s.serve_forever()`;
  const server = spawn('python3', ['-u', '-c', code], {cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'inherit']});
  let browser;
  const statuses = [];
  try {
    const [chunk] = await once(server.stdout, 'data'); const port = Number(String(chunk).trim()); assert(port > 0);
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN, args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context = await browser.newContext({viewport: {width: 1360, height: 1700}});
    await context.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    page.on('response', r => { if (/\/api\/finding/.test(r.url())) statuses.push(`${new URL(r.url()).pathname} ${r.status()}`); });
    await page.goto(`http://127.0.0.1:${port}`);
    const caps = await page.evaluate(async () => (await (await fetch('/api/data')).json()).capabilities.ledger_actions);
    assert.equal(caps.submission.enabled, true); assert.equal(caps.add_finding.enabled, true);
    assert.equal(caps.reclassify.gadgets.enabled, true); assert.equal(caps.reclassify.map.enabled, true);
    await page.getByRole('button', {name: 'Programs', exact: true}).click();
    await page.locator('tr[data-finding-id]').first().waitFor();
    await page.getByRole('button', {name: /^Sort findings/}).click(); await page.getByRole('menuitemradio', {name: 'Severity, highest first'}).click();
    assert.deepEqual(await page.locator('tbody tr[data-finding-id]').evaluateAll(r => r.map(x => x.querySelector('.finding-title').textContent)), ['Synthetic fetch', 'Synthetic stored note', 'Synthetic object access']);
    // Class via searchable picker.
    const idFor = title => byTitle(title).fid;
    await page.getByRole('button', {name: 'Actions for Synthetic stored note'}).click();
    await page.getByRole('menuitem', {name: 'Change class…'}).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', {name: 'Class'}).fill('stored-xss');
    await dialog.getByRole('button', {name: 'Save class'}).click();
    await dialog.getByText('Saved. Class is now stored-xss.').waitFor();
    assert.equal(byTitle('Synthetic stored note').class_name, 'stored-xss');
    await dialog.getByRole('button', {name: 'Cancel'}).click();
    // Submission state: local only.
    await page.getByRole('button', {name: 'Actions for Synthetic stored note'}).click();
    await page.getByRole('menuitem', {name: 'Set submission state…'}).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Submission state').selectOption('submitted');
    await dialog.getByLabel('Platform result').selectOption('duplicate');
    await dialog.getByLabel('I understand this only records local state.').check();
    await dialog.getByRole('button', {name: 'Record state'}).click();
    await dialog.getByText(/Recorded locally: Submitted, result duplicate/).waitFor();
    assert.deepEqual(byTitle('Synthetic stored note').submission, {state: 'submitted', result: 'duplicate'});
    await dialog.getByRole('button', {name: 'Cancel'}).click();
    // Drag to Gadgets.
    const fetchId = idFor('Synthetic fetch');
    await page.locator(`tr[data-finding-id="${fetchId}"]`).dragTo(page.locator('.workspace-nav [data-drop-target="gadgets"]'), {sourcePosition: {x: 12, y: 12}});
    dialog = page.getByRole('dialog', {name: /Move to Gadgets/});
    await dialog.getByLabel('Grants').fill('synthetic server fetch');
    await dialog.getByLabel('Requires', {exact: true}).fill('authenticated user');
    await dialog.getByLabel('Crosses', {exact: true}).fill('user-input->server-fetch');
    await dialog.getByRole('button', {name: 'Move to Gadgets'}).click();
    await dialog.getByText(/Created Gadgets entry recon\/maps\/ssrf\/_surface\//).waitFor();
    await dialog.getByRole('button', {name: 'Close'}).click();
    const gadget = mapEntries().find(e => e.tags.includes('gadget'));
    assert.deepEqual(gadget.tags, ['finding-' + fetchId.toLowerCase(), 'from-ledger', 'gadget']);
    assert.equal(gadget.agent, 'bounty-board'); assert.equal(gadget.scope, 'surface');
    const gadgetBody = fs.readFileSync(path.join(lane, 'recon/maps', gadget.path), 'utf8');
    assert.match(gadgetBody, /Capability:\n- grants: synthetic server fetch\n- requires: authenticated user\n- crosses: user-input->server-fetch\n- chain_status: deferred/);
    assert.match(gadgetBody, new RegExp(`Source finding: ${fetchId} \\(web_bounty/fictional.example/web\\)`));
    const fetched = byTitle('Synthetic fetch');
    assert.equal(fetched.severity, 'HIGH'); assert.equal(fetched.evidence_path, evidence); assert(fs.existsSync(evidence));
    assert.match(fetched.review_notes, new RegExp(`Reclassified to Gadgets on \\d{4}-\\d{2}-\\d{2} by Bounty Board: recon/maps/${gadget.path.replace(/[.]/g, '\\.')}`));
    assert.equal(ledger().length, 3);
    // Non-drag MapStore move, with archive.
    await page.getByRole('button', {name: 'Actions for Synthetic object access'}).click();
    await page.getByRole('menuitem', {name: 'Move to MapStore…'}).click();
    dialog = page.getByRole('dialog', {name: /Move to MapStore/});
    await dialog.getByLabel('Note').fill('Synthetic multi-line\nobservation');
    await dialog.getByLabel('Also set the finding status to archive').check();
    await dialog.getByRole('button', {name: 'Move to MapStore'}).click();
    await dialog.getByText(/Created MapStore entry/).waitFor();
    await dialog.getByRole('button', {name: 'Close'}).click();
    const observation = mapEntries().find(e => !e.tags.includes('gadget'));
    assert(observation.tags.includes('from-ledger'));
    const access = byTitle('Synthetic object access');
    assert.equal(access.status, 'archive'); assert.equal(access.current.status, 'archive'); assert.equal(access.severity, 'INFO');
    // Second move of the same finding is refused before any writer call.
    const writesBefore = fs.readFileSync(marker, 'utf8');
    const again = await page.evaluate(async fid => {
      const data = await (await fetch('/api/data')).json();
      const finding = data.programs[0].lanes[0].findings.find(f => f.fid === fid);
      const r = await fetch('/api/finding/reclassify', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify({family: 'web_bounty', program: 'fictional.example', lane: 'web', fid, expected_revision: finding.metadata_revision, root_instance: data.root_instance, destination: 'map', details: {title: 'Again', surface: 'idor'}})});
      return [r.status, (await r.json()).error];
    }, access.fid);
    assert.deepEqual(again, [409, 'already_reclassified']); assert.equal(fs.readFileSync(marker, 'utf8'), writesBefore);
    // Add finding through the form, then a duplicate note.
    const add = async () => {
      await page.getByRole('button', {name: 'Add finding'}).click();
      dialog = page.getByRole('dialog', {name: /Add finding/});
      await dialog.getByLabel('Title').fill('Synthetic board added');
      await dialog.getByRole('combobox', {name: 'Class'}).fill('open-redirect');
      await dialog.getByLabel('Severity').selectOption('MEDIUM');
      await dialog.getByLabel('File or asset').fill('/redirect');
      await dialog.getByLabel('Description').fill('Fixture only.');
      await dialog.getByRole('button', {name: 'Add finding'}).click();
    };
    await add(); await dialog.getByText(/^Added D\d+\.$/).waitFor(); await dialog.getByRole('button', {name: 'Cancel'}).click();
    const added = byTitle('Synthetic board added');
    assert.equal(added.class_name, 'open-redirect'); assert.equal(added.severity, 'MEDIUM'); assert(fs.existsSync(added.evidence_path));
    await add(); await dialog.getByText(/it may match an existing one/).waitFor(); await dialog.getByRole('button', {name: 'Cancel'}).click();
    assert.equal(ledger().length, 4);
    // The writer stays enabled after BBH's documented duplicate no-op.
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/data')).json()).capabilities.finding_metadata), true);
    assert.deepEqual(fs.readdirSync(home), [], 'nothing written to HOME');
    console.log('PASS: real BBH class, submission, gadget drag, MapStore menu, add, duplicate', statuses);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM'); await once(server, 'exit').catch(() => {});
  }
  if (!process.env.KEEP_E2E) fs.rmSync(work, {recursive: true, force: true});
}
main().catch(e => { console.error(e); process.exitCode = 1; });

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('every literal app translation key has Spanish coverage', () => {
  const i18n = require('../public/i18n.js');
  i18n.setLang('es');
  const source = read('public/app.js');
  const literals = /\bT\(\s*('(?:\\.|[^'])*'|"(?:\\.|[^"])*")/g;
  const keys = new Set();
  let match;
  while ((match = literals.exec(source))) {
    keys.add(Function(`return ${match[1]}`)());
  }
  const intentionallyShared = new Set([
    'Color', 'ETA', 'GPS', 'Hablamos español', 'No', 'premium', 'Premium $', 'W-9'
  ]);
  const missing = [...keys].filter(key =>
    /[A-Za-z]/.test(key) && i18n.T(key) === key && !intentionallyShared.has(key));
  assert.deepEqual(missing, []);
  assert.ok(keys.size >= 300, 'translation audit should cover the complete application surface');
});

test('browser-reachable static server errors have Spanish coverage', () => {
  const i18n = require('../public/i18n.js');
  i18n.setLang('es');
  const messages = new Set();
  const pattern = /(?:error\s*:\s*|new Error\s*\()(['"])([^'"\n]{3,180})\1/g;
  for (const file of fs.readdirSync(path.join(root, 'server')).filter(name => name.endsWith('.js'))) {
    const source = read(`server/${file}`);
    let match;
    while ((match = pattern.exec(source))) {
      if (/[A-Za-z]/.test(match[2])) messages.add(match[2]);
    }
  }
  const missing = [...messages].filter(message => i18n.T(message) === message);
  assert.deepEqual(missing, []);
  assert.ok(messages.size >= 70, 'server error audit should remain broad');
});

test('frontend keeps the shared accessibility and resilience baseline', () => {
  const app = read('public/app.js');
  const styles = read('public/styles.css');
  const index = read('public/index.html');
  const recruiting = read('public/for-service-companies.html');
  const routes = read('server/routes.js');

  assert.match(index, /id="toast" role="status" aria-live="polite"/);
  assert.doesNotMatch(index, /id="root"[^>]*aria-live/);
  assert.match(styles, /prefers-reduced-motion:reduce/);
  assert.match(styles, /button\{min-height:44px/);
  assert.match(styles, /--focus:#1f6f78/);
  assert.match(app, /function updateFormProgress[\s\S]*sessionStorage\.setItem\(key/);
  assert.doesNotMatch(app, /querySelectorAll\('#root input,#root textarea,#root select'\)/);
  assert.match(app, /view === 'a-provider'.*provider-\$\{S\.adminProviderId/s);
  assert.match(app, /function pickAxle[\s\S]*saveFormSelection\(\$\('rq-tire-axle'\)\);\s*render\(\)/);
  assert.match(app, /function saveAdminNotes[\s\S]*const draftKey = formProgressKey\('a-provider'\);[\s\S]*await api[\s\S]*clearFormProgressKey\(draftKey\)/);
  assert.match(app, /function postChat[\s\S]*const draftKey = formProgressKey\(originView\);[\s\S]*await api[\s\S]*clearCommittedProgressFields\(draftKey/);
  assert.match(app, /function sendQuote[\s\S]*const draftKey = formProgressKey\(originView\);[\s\S]*await api[\s\S]*clearCommittedProgressFields\(draftKey/);
  assert.match(app, /RIGRXFormProgress\.syncOtherControl\(select, input\)/);
  assert.ok(app.includes("updateFormProgress({ [id]: city.label, [`__city_${id}`]: city });"));
  assert.match(app, /function ensureFormProgressCurrent[\s\S]*isEntityDraftCurrent[\s\S]*clearFormProgressKey/);
  assert.match(app, /if \(RIGRXFormProgress\.shouldPersistSelection\(group\)\) saveFormSelection\(group\)/);
  assert.match(app, /function uploadDoc[\s\S]*verification: \{ \[key\]: data\.url \}/);
  assert.match(routes, /verification = CASE WHEN \$8::jsonb IS NULL THEN verification[\s\S]*COALESCE\(verification, '\{\}'::jsonb\) \|\| \$8::jsonb/);
  assert.match(app, /function uploadPhoto[\s\S]*__uploads_rq-photo[\s\S]*service_key[\s\S]*references/);
  assert.match(app, /function pickSvc[\s\S]*service_key !== key[\s\S]*S\.draft\.photos = \[\][\s\S]*__uploads_rq-photo/);
  assert.match(app, /Live updates disconnected\. Reconnecting/);
  assert.match(app, /setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /document\.createElement\('button'\)/);
  assert.match(app, /setAttribute\('role', 'dialog'\)/);
  assert.match(app, /toast\(T\('Truck saved'\), true\)/);
  assert.match(app, /toast\(T\('Trailer saved'\), true\)/);
  assert.match(app, /toast\(T\('Card saved[^\n]+, true\);/);
  assert.match(recruiting, /rigrx_public_lang/);
  assert.match(recruiting, /rigrx_waitlist_draft/);
  assert.match(recruiting, /className = 'field-error'/);
  assert.match(recruiting, /role="status" aria-live="polite"/);
});
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalChipValue,
  truckDraftFromProgress,
  clearCommittedFields,
  syncOtherControl,
  isProgressFieldAllowed,
  normalizeCitySelection,
  normalizeUploadedReferences,
  uploadedReferencesForService,
  stableFingerprint,
  isEntityDraftCurrent,
  shouldPersistSelection,
  providerDraftEntity
} = require('../public/form-progress.js');

test('persisted chips use canonical identifiers instead of translated labels', () => {
  assert.equal(canonicalChipValue({ k: 'mobile_service' }, 'Servicio móvil'), 'mobile_service');
  assert.equal(canonicalChipValue({ k: 'mobile_service', en: 'Mobile service' }, 'Servicio móvil'), 'mobile_service');
  assert.equal(canonicalChipValue({ id: '42' }, 'Unidad 7'), '42');
  assert.equal(canonicalChipValue({ id: '' }, 'Sin camión guardado'), '');
  assert.equal(canonicalChipValue({ icon: 'wrench' }, ''), 'wrench');
});

test('truck drafts restore controller state and dependent values before submission', () => {
  const saved = truckDraftFromProgress({
    '__chips_duty-class': ['medium'],
    '__chips_tk-extras': ['Sleeper'],
    'tk-unit': '17',
    'tk-year': '2024',
    'tk-make': 'Freightliner',
    'tk-model': 'M2 106',
    'tk-engine': 'Cummins B6.7',
    'tk-trans': 'Automatic',
    'tk-axles': '4x2',
    'tk-steer': '11R22.5',
    'tk-drive': '11R22.5',
    'tk-wheels': 'Aluminum',
    'tk-color': 'White',
    'tk-vin': 'TESTVIN'
  });

  const state = { dutyClass: 'heavy' };
  if (saved.duty) state.dutyClass = saved.duty;
  const submitted = { ...saved, duty: state.dutyClass };

  assert.equal(state.dutyClass, 'medium');
  assert.equal(submitted.duty, 'medium');
  assert.equal(submitted.make, 'Freightliner');
  assert.equal(submitted.model, 'M2 106');
  assert.deepEqual(submitted.extras, ['Sleeper']);
});

test('custom make and model drafts restore their typed canonical values', () => {
  const saved = truckDraftFromProgress({
    '__chips_duty-class': ['light'],
    'tk-make': '__other',
    'tk-make-other': 'Custom Make',
    'tk-model': '__other',
    'tk-model-other': 'Custom Model'
  });

  assert.deepEqual(saved, {
    make: 'Custom Make',
    model: 'Custom Model',
    duty: 'light'
  });
});

test('a delayed send clears only its unchanged originating draft', () => {
  const conversationA = { __revision: 3, chatIn: 'On my way' };
  const conversationB = { __revision: 8, chatIn: 'Different conversation' };
  const sent = clearCommittedFields(conversationA, { chatIn: 'On my way' }, 3);

  assert.equal(sent.changed, true);
  assert.equal(sent.progress.chatIn, undefined);
  assert.deepEqual(conversationB, { __revision: 8, chatIn: 'Different conversation' });

  const newerSameText = { __revision: 4, chatIn: 'On my way' };
  const staleCompletion = clearCommittedFields(newerSameText, { chatIn: 'On my way' }, 3);
  assert.equal(staleCompletion.changed, false);
  assert.deepEqual(staleCompletion.progress, newerSameText);

  const spacedInput = { __revision: 5, chatIn: '  On my way  ' };
  const trimmedPayload = 'On my way';
  const exactInputCleanup = clearCommittedFields(
    spacedInput,
    { chatIn: spacedInput.chatIn },
    5
  );
  assert.equal(trimmedPayload, spacedInput.chatIn.trim());
  assert.equal(exactInputCleanup.progress.chatIn, undefined);
});

test('restoring an Other selection makes its custom trailer field visible', () => {
  let focused = false;
  const select = { value: '__other' };
  const input = { style: { display: 'none' }, focus(){ focused = true; } };

  assert.equal(syncOtherControl(select, input), true);
  assert.equal(input.style.display, 'block');
  assert.equal(focused, false);

  select.value = 'Dry van';
  assert.equal(syncOtherControl(select, input), false);
  assert.equal(input.style.display, 'none');
});

test('authoritative admin pricing and catalog fields are never draft-restored', () => {
  assert.equal(isProgressFieldAllowed('a-pricing', 'std-mobile'), false);
  assert.equal(isProgressFieldAllowed('a-pricing', 'prm-mobile'), false);
  assert.equal(isProgressFieldAllowed('a-catalog', 'nc-std'), false);
  assert.equal(isProgressFieldAllowed('a-provider', 'cr-amt'), false);
  assert.equal(isProgressFieldAllowed('a-provider', 'adm-notes'), true);
  assert.equal(isProgressFieldAllowed('p-setup2', 'loc-city'), true);
});

test('validated city selections restore both their label and coordinates', () => {
  assert.deepEqual(
    normalizeCitySelection({ label: 'Bakersfield, CA', lat: '35.3733', lng: '-119.0187' }),
    { label: 'Bakersfield, CA', lat: 35.3733, lng: -119.0187 }
  );
  assert.equal(normalizeCitySelection({ label: 'Bakersfield, CA' }), null);
  assert.equal(normalizeCitySelection({ label: '', lat: 35, lng: -119 }), null);
});

test('uploaded request drafts persist only authenticated app references, not file contents', () => {
  assert.deepEqual(normalizeUploadedReferences([
    '/api/uploads/photo-1.jpg',
    'data:image/png;base64,private',
    'https://example.com/photo.jpg',
    '/api/uploads/photo-1.jpg',
    '/api/uploads/photo_2.webp'
  ]), ['/api/uploads/photo-1.jpg', '/api/uploads/photo_2.webp']);
  const tireDraft = { service_key: 'tires', references: ['/api/uploads/photo-1.jpg'] };
  assert.deepEqual(uploadedReferencesForService(tireDraft, 'tires'), ['/api/uploads/photo-1.jpg']);
  assert.deepEqual(uploadedReferencesForService(tireDraft, 'towing'), []);
});

test('entity drafts are discarded when authoritative data changes elsewhere', () => {
  const original = stableFingerprint({ name: 'Roadside', services: { tire: ['Flat'] } });
  const same = stableFingerprint({ services: { tire: ['Flat'] }, name: 'Roadside' });
  const updated = stableFingerprint({ name: 'Roadside', services: { tire: ['Flat', 'Blowout'] } });

  assert.equal(original, same);
  assert.equal(isEntityDraftCurrent({ __entityFingerprint: original }, same), true);
  assert.equal(isEntityDraftCurrent({ __entityFingerprint: original }, updated), false);
  assert.equal(isEntityDraftCurrent({}, updated), false);
});

test('a detached duty group cannot overwrite the synchronously saved class', () => {
  let progress = { '__chips_duty-class': ['heavy'] };
  const oldGroup = { isConnected: true };
  const deferredSave = () => {
    if (shouldPersistSelection(oldGroup)) progress['__chips_duty-class'] = ['heavy'];
  };

  progress['__chips_duty-class'] = ['medium'];
  oldGroup.isConnected = false;
  deferredSave();

  assert.deepEqual(progress['__chips_duty-class'], ['medium']);
  assert.equal(truckDraftFromProgress(progress).duty, 'medium');
});

test('local custom-service and document mutations do not invalidate unrelated drafts', () => {
  const servicesBefore = providerDraftEntity('p-setup3', {
    primary_trade: 'roadside',
    services: { tires: ['Flat repair'] },
    custom: []
  });
  const servicesAfterCustomAdd = providerDraftEntity('p-setup3', {
    primary_trade: 'roadside',
    services: { tires: ['Flat repair'] },
    custom: [{ name: 'Alignment', status: 'pending' }]
  });
  assert.equal(stableFingerprint(servicesBefore), stableFingerprint(servicesAfterCustomAdd));

  const verificationBefore = providerDraftEntity('p-setup5', {
    verification: { license: 'CA-123', coi_file: '' }
  });
  const verificationAfterUpload = providerDraftEntity('p-setup5', {
    verification: { license: 'CA-123', coi_file: '/api/uploads/coi.pdf' }
  });
  assert.equal(stableFingerprint(verificationBefore), stableFingerprint(verificationAfterUpload));
  assert.notEqual(
    stableFingerprint(verificationBefore),
    stableFingerprint(providerDraftEntity('p-setup5', { verification: { license: 'CA-999' } }))
  );
});
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RIGRXFormProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
  const draftViews = new Set([
    'd-request', 'd-details', 'd-location', 'd-setup1', 'd-setup2', 'd-setup3',
    'd-rate', 'd-chat',
    'p-setup1', 'p-setup2', 'p-setup3', 'p-setup4', 'p-setup5',
    'p-lead', 'p-chat', 'p-people'
  ]);

  function isProgressFieldAllowed(view, field) {
    if (!view || !field) return false;
    if (draftViews.has(view)) return true;
    return view === 'a-provider' && field === 'adm-notes';
  }

  function canonicalChipValue(dataset, visibleText) {
    for (const key of ['v', 'value', 'key', 'k', 'id', 'icon', 'en']) {
      if (own(dataset, key)) return String(dataset[key] ?? '');
    }
    return String(visibleText || '').trim();
  }

  function truckDraftFromProgress(progress) {
    if (!progress || typeof progress !== 'object') return null;
    const draft = {};
    const copyField = (field, id) => {
      if (!own(progress, id)) return;
      const selected = progress[id];
      draft[field] = selected === '__other'
        ? String(progress[`${id}-other`] || '').trim()
        : String(selected ?? '');
    };
    const fields = {
      unit: 'tk-unit',
      year: 'tk-year',
      make: 'tk-make',
      model: 'tk-model',
      engine: 'tk-engine',
      trans: 'tk-trans',
      axles: 'tk-axles',
      steer: 'tk-steer',
      drive: 'tk-drive',
      wheels: 'tk-wheels',
      color: 'tk-color',
      vin: 'tk-vin'
    };
    Object.entries(fields).forEach(([field, id]) => copyField(field, id));

    const duty = progress['__chips_duty-class'];
    if (Array.isArray(duty) && duty.length) draft.duty = String(duty[0]);
    const extras = progress['__chips_tk-extras'];
    if (Array.isArray(extras)) draft.extras = extras.map(String);

    return Object.keys(draft).length ? draft : null;
  }

  function clearCommittedFields(progress, committed, expectedRevision) {
    if (!progress || typeof progress !== 'object') return { changed: false, progress };
    const revision = Number(progress.__revision || 0);
    if (revision !== Number(expectedRevision || 0)) return { changed: false, progress };
    const next = { ...progress };
    let changed = false;
    Object.entries(committed || {}).forEach(([field, value]) => {
      if (own(next, field) && next[field] === value) {
        delete next[field];
        changed = true;
      }
    });
    if (!changed) return { changed: false, progress };
    next.__revision = revision + 1;
    return { changed: true, progress: next };
  }

  function syncOtherControl(select, input, focus = false) {
    if (!select || !input) return false;
    const isOther = select.value === '__other';
    input.style.display = isOther ? 'block' : 'none';
    if (isOther && focus && typeof input.focus === 'function') input.focus();
    return isOther;
  }

  function normalizeCitySelection(city) {
    if (!city || typeof city !== 'object') return null;
    const label = String(city.label || '').trim();
    const lat = Number(city.lat);
    const lng = Number(city.lng);
    if (!label || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { ...city, label, lat, lng };
  }

  function normalizeUploadedReferences(references) {
    if (!Array.isArray(references)) return [];
    return [...new Set(references
      .map(value => String(value || '').trim())
      .filter(value => /^\/api\/uploads\/[A-Za-z0-9._-]+$/.test(value)))];
  }

  function uploadedReferencesForService(uploadDraft, serviceKey) {
    if (!uploadDraft || uploadDraft.service_key !== serviceKey) return [];
    return normalizeUploadedReferences(uploadDraft.references);
  }

  function stableFingerprint(value) {
    const normalize = input => {
      if (Array.isArray(input)) return input.map(normalize);
      if (input && typeof input === 'object') {
        return Object.keys(input).sort().reduce((out, key) => {
          if (input[key] !== undefined) out[key] = normalize(input[key]);
          return out;
        }, {});
      }
      return input;
    };
    return JSON.stringify(normalize(value));
  }

  function isEntityDraftCurrent(progress, currentFingerprint) {
    if (!progress || !currentFingerprint) return true;
    return progress.__entityFingerprint === currentFingerprint;
  }

  function shouldPersistSelection(control) {
    return !!control?.isConnected;
  }

  function providerDraftEntity(view, provider) {
    if (!provider) return null;
    if (view === 'p-setup1') return {
      name: provider.name, address: provider.address, dispatch_phone: provider.dispatch_phone,
      email: provider.email, hours: provider.hours
    };
    if (view === 'p-setup3') return {
      primary_trade: provider.primary_trade, services: provider.services
    };
    if (view === 'p-setup4') return {
      capabilities: provider.capabilities, duty_classes: provider.duty_classes, equipment: provider.equipment
    };
    if (view === 'p-setup5') return {
      license: provider.verification?.license
    };
    return null;
  }

  return {
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
  };
});
/* Board taxonomy module: display-time normalization of finding classes and
 * severity. Rules come from /taxonomy-rules.json (shared with taxonomy.py).
 * Pure functions only; raw values are never rewritten. Works in the browser
 * (window.BoardTaxonomy) and in Node (module.exports) for tests. */
(function (root) {
  'use strict';
  let rules = null, compiled = null;

  function configure(json) {
    rules = json;
    compiled = {
      rules: json.rules.map(r => ({id: r.id, to: r.to, patterns: r.patterns.map(p => new RegExp(p))})),
      categories: Object.fromEntries(json.categories.map(c => [c.id, c])),
      ranges: new RegExp(json.severity.ranges),
      junk: new Set(json.junk)
    };
  }
  const ready = () => !!compiled;
  const normalizeLabel = raw => String(raw).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function result(category, subclass, raw, confidence, reason, alternates) {
    let label;
    if (category === 'unclassified') label = rules ? rules.unclassified.label : 'Unclassified';
    else {
      const cat = compiled.categories[category];
      label = cat.label;
      if (subclass) label += ' > ' + cat.subclasses.find(s => s.id === subclass).label;
    }
    const out = {category, subclass, label, raw, confidence, alternates: alternates || []};
    if (reason) out.reason = reason;
    return out;
  }

  function normalizeClass(raw) {
    if (!compiled) return {category: 'unclassified', subclass: null, label: 'Unclassified', raw, confidence: 'none', alternates: [], reason: 'rules_not_loaded'};
    if (raw == null || typeof raw === 'object') return result('unclassified', null, raw, 'none', 'empty');
    const text = normalizeLabel(raw);
    if (compiled.junk.has(text)) return result('unclassified', null, raw, 'none', text ? 'placeholder' : 'empty');
    if (Object.prototype.hasOwnProperty.call(rules.aliases, text)) {
      const [category, subclass] = rules.aliases[text].split('/');
      return result(category, subclass, raw, 'high');
    }
    const hits = [];
    for (const rule of compiled.rules) if (rule.patterns.some(p => p.test(text))) hits.push(rule.to.split('/'));
    if (!hits.length) return result('unclassified', null, raw, 'none', 'no_rule');
    const [category, subclass] = hits[0];
    const alternates = [];
    for (const [other] of hits.slice(1)) if (other !== category && !alternates.includes(other)) alternates.push(other);
    const words = text.split(' ').length;
    const confidence = words > 8 || /\b(hunter|auditor)$/.test(text) ? 'low' : 'medium';
    return result(category, subclass, raw, confidence, null, alternates);
  }

  // Mirrors bounty_core.finding.normalize_severity (BBH) so Board and ledger agree.
  function normalizeSeverity(raw) {
    const sev = rules && rules.severity;
    const text = raw == null ? '' : String(raw).trim();
    const upper = text.toUpperCase();
    if (!upper) return {value: 'UNKNOWN', raw, kind: 'missing', note: null};
    if (!sev) return {value: upper, raw, kind: 'rules_not_loaded', note: null};
    if (sev.canonical.includes(upper) || sev.passthrough.includes(upper)) return {value: upper, raw, kind: 'canonical', note: null};
    if (Object.prototype.hasOwnProperty.call(sev.aliases, upper)) return {value: sev.aliases[upper], raw, kind: 'alias', note: null};
    if (sev.placeholders.includes(upper)) return {value: 'UNKNOWN', raw, kind: 'placeholder', note: 'Template placeholder, not a rating.'};
    if (compiled.ranges.test(upper)) return {value: 'UNKNOWN', raw, kind: 'range', note: 'Range recorded; a single rating is needed.'};
    return {value: 'UNKNOWN', raw, kind: 'unmapped', note: Object.prototype.hasOwnProperty.call(sev.unmapped_notes, upper) ? sev.unmapped_notes[upper] : null};
  }

  const categories = () => rules ? rules.categories : [];
  const api = {configure, ready, normalizeClass, normalizeSeverity, normalizeLabel, categories};

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) {
    root.BoardTaxonomy = api;
    let rerender = null;
    fetch('/taxonomy-rules.json', {credentials: 'same-origin'})
      .then(r => r.ok ? r.json() : Promise.reject(new Error('rules unavailable')))
      .then(json => { configure(json); if (rerender) rerender(); })
      .catch(error => console.error('Taxonomy rules failed to load:', error));
    if (root.registerBoardModule) root.registerBoardModule({name: 'taxonomy', afterRender(ctx) { rerender = ctx.render; }});
  }
})(typeof window !== 'undefined' ? window : null);

import './style.css';
import {
  parseDoc, detectGenerator, classifyViolations, remediation, builtinChecklist,
  REMEDIATION_TABLE,
  type Violation, type DetectResult, type ClassifyResult, type ClassifiedViolation, type Concern, type GeneratorId,
} from './codefirst';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const val = (s: string) => ($(s) as HTMLTextAreaElement | HTMLInputElement).value;
const setVal = (s: string, v: string) => { ($(s) as HTMLTextAreaElement | HTMLInputElement).value = v; };
const ptr = (p?: (string | number)[]) => '/' + (p ?? []).join('/');

const CONCERN_LABEL: Record<Concern, string> = {
  description: 'Descriptions', summary: 'Summaries', operationId: 'operationIds', tags: 'Tags',
  examples: 'Examples', responses: 'Responses', 'schema-naming': 'Schema names',
};

let sampleOpenapi = '', sampleResults = '';
let lastWorklist: any[] = [];

init();
async function init() {
  wire();
  try {
    [sampleOpenapi, sampleResults] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}sample-openapi.json`).then((r) => r.text()),
      fetch(`${import.meta.env.BASE_URL}sample-spectral.json`).then((r) => r.text()),
    ]);
    setVal('#openapi-text', sampleOpenapi);
    setVal('#results-text', sampleResults);
    run();
  } catch (e) { $('#report').innerHTML = `<div class="cov-error">Couldn't load samples. ${esc((e as Error).message)}</div>`; }
}

function wire() {
  $('#analyze').addEventListener('click', run);
  $('#load-sample').addEventListener('click', () => { setVal('#openapi-text', sampleOpenapi); setVal('#results-text', sampleResults); run(); });
  $('#up-openapi').addEventListener('click', () => $('#file-openapi').click());
  $('#up-results').addEventListener('click', () => $('#file-results').click());
  $('#file-openapi').addEventListener('change', (e) => readFile(e, '#openapi-text'));
  $('#file-results').addEventListener('change', (e) => readFile(e, '#results-text'));
  $('#engage-ae').addEventListener('click', () => { location.href = 'mailto:info@apievangelist.com?subject=' + encodeURIComponent('Code-first API governance — annotations & Spectral'); });
  $('#nav-about').addEventListener('click', (e) => { e.preventDefault(); about(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('about-modal')?.remove(); });
}

function readFile(e: Event, target: string) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => { setVal(target, String(r.result)); run(); }; r.readAsText(f);
}

function run() {
  let doc: any;
  try { doc = parseDoc(val('#openapi-text')); }
  catch (e) { return err(`Couldn't parse the generated OpenAPI: ${(e as Error).message}`); }

  const det = detectGenerator(doc);

  let violations: Violation[];
  let usedBuiltin = false;
  const rawResults = val('#results-text').trim();
  if (rawResults) {
    try { violations = JSON.parse(rawResults); if (!Array.isArray(violations)) throw new Error('Expected a JSON array of Spectral results.'); }
    catch (e) { return err(`Couldn't parse Spectral results: ${(e as Error).message}`); }
  } else {
    violations = builtinChecklist(doc);
    usedBuiltin = true;
  }

  const classified = classifyViolations(violations);
  $('#status').innerHTML = `<b>${esc(det.name)}</b>${det.generator !== 'unknown' ? ` · ${Math.round(det.confidence * 100)}% confidence` : ''} · <b style="color:var(--warn)">${classified.counts.codegen}</b> fix-in-code · <b>${classified.counts.authoring}</b> fix-in-spec`;
  render(det, classified, usedBuiltin);
}
function err(msg: string) { $('#report').innerHTML = `<div class="cov-error">${esc(msg)}</div>`; }

function confColor(c: number): string { return c >= 0.66 ? 'var(--ok)' : c >= 0.4 ? 'var(--warn)' : 'var(--muted)'; }

function render(det: DetectResult, c: ClassifyResult, usedBuiltin: boolean) {
  const runners = det.ranked.filter((r) => r.score > 0 && r.id !== det.generator).slice(0, 2);
  const evidenceChips = det.evidence.length
    ? `<div class="chips">${det.evidence.map((e) => `<span class="chip">${esc(e)}</span>`).join('')}</div>`
    : `<div class="chips"><span class="chip muted">No generator fingerprints matched — looks hand-authored.</span></div>`;

  // Remediation, grouped by concern present in the code-gen findings.
  const concerns = Object.keys(c.byConcern) as Concern[];
  const remCards = concerns.map((concern) => {
    const items = c.byConcern[concern]!;
    const codes = [...new Set(items.map((i) => i.code))];
    const g = remediation(items[0].code, det.generator);
    return `<div class="wr codegen">
      <div class="wr-top"><span class="wr-id">${esc(CONCERN_LABEL[concern])}</span><span class="wr-rule">${esc(codes.join(', '))}</span><span class="wr-status codegen">${items.length}×</span></div>
      <div class="wr-scope">fix in code · ${esc(det.name)}</div>
      <div class="wr-meta"><span class="guide">${esc(g.guidance)}</span></div>
    </div>`;
  }).join('') || `<p class="small muted">No code-gen-caused findings to remediate — nice.</p>`;

  lastWorklist = c.codegen.map((v) => ({
    code: v.code, concern: v.concern, path: ptr(v.path), source: v.source,
    generator: det.generator, fixInCode: remediation(v.code, det.generator).guidance,
  }));

  $('#report').innerHTML = `
    <div class="hero">
      <div class="gauge">
        <div class="gauge-num" style="color:${confColor(det.confidence)}">${det.generator !== 'unknown' ? Math.round(det.confidence * 100) + '%' : '—'}</div>
        <div class="gauge-cap">detection<br>confidence</div>
      </div>
      <div class="facts">
        <div class="fact"><b class="gen">${esc(det.name)}</b><span>likely generator</span></div>
        <div class="fact"><b>${esc(det.language)}${det.framework !== '—' ? ' · ' + esc(det.framework) : ''}</b><span>language / framework</span></div>
        <div class="fact warnf"><b>${c.counts.codegen}</b><span>fix in code (regenerate)</span></div>
        <div class="fact"><b>${c.counts.authoring}</b><span>fix in the spec</span></div>
        <div class="fact"><b>${c.counts.total}</b><span>findings analyzed</span></div>
      </div>
    </div>
    <div class="evidence">
      <span class="ev-label">Detected because</span>${evidenceChips}
      ${runners.length ? `<span class="ev-label">Runners-up</span><div class="chips">${runners.map((r) => `<span class="chip muted">${esc(r.name)} (${r.score})</span>`).join('')}</div>` : ''}
    </div>
    <p class="hint small">Code-first teams generate their OpenAPI from annotations — so a finding you "fix" by editing the spec is <strong>overwritten on the next build</strong>. This separates the findings that must be fixed <strong>in code</strong> (left) from genuine <strong>spec-authoring</strong> findings (right), and the panel below tells you the exact annotation to add for <strong>${esc(det.name)}</strong>.${usedBuiltin ? ' <em>No Spectral output supplied — showing the built-in checklist derived from your document.</em>' : ''}</p>

    <div class="cols">
      <section class="panel">
        <h3>Fix in code <span class="muted">(${c.counts.codegen})</span></h3>
        <p class="small">Caused by code generation — editing the regenerated spec won't stick. Fix the annotation, then regenerate.</p>
        <div class="vlist">${c.codegen.map((v) => vrow(v, 'codegen')).join('') || empty('No code-gen-caused findings.')}</div>
      </section>
      <section class="panel">
        <h3>Fix in the spec <span class="muted">(${c.counts.authoring})</span></h3>
        <p class="small">Spec-authoring / generator-config findings — safe to fix in the source document or config.</p>
        <div class="vlist">${c.authoring.map((v) => vrow(v, 'authoring')).join('') || empty('No spec-authoring findings.')}</div>
      </section>
    </div>

    <section class="panel rem-panel">
      <h3>Remediation — where to fix it in code</h3>
      <p class="small">One card per concern found in your code-gen findings, mapped to the annotation for the detected generator.</p>
      <div class="wtable">${remCards}</div>
    </section>

    <div class="export-bar">
      <button class="measure-btn" id="dl-worklist" type="button">Download code-fix worklist (${lastWorklist.length}) ↓</button>
      <span class="muted small">A per-finding checklist of the annotation to add — hand it to the team that owns the code.</span>
    </div>`;

  $('#dl-worklist').addEventListener('click', () => download('codefirst-worklist.json', JSON.stringify(lastWorklist, null, 2), 'application/json'));
}

function empty(msg: string): string { return `<div class="vrow"><span class="vmain"><span class="muted small">${esc(msg)}</span></span></div>`; }

function vrow(v: ClassifiedViolation, state: 'codegen' | 'authoring'): string {
  const label = state === 'codegen' ? 'in code' : 'in spec';
  const tail = v.concern ? `<div class="vby">${esc(v.concern)}</div>` : '';
  return `<div class="vrow ${state}"><span class="vstate ${state}">${label}</span>
    <div class="vmain"><div class="vcode">${esc(v.code)}</div><div class="vpath">${esc(v.title)} · ${esc(ptr(v.path))}${v.source ? ' · ' + esc(v.source) : ''}</div></div>${tail}</div>`;
}

function download(name: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

function about() {
  const gens = Object.keys(REMEDIATION_TABLE.description).filter((k) => k !== 'default') as GeneratorId[];
  const el = document.createElement('div');
  el.id = 'about-modal';
  el.innerHTML = `<div class="about-backdrop"></div><div class="about-card">
    <button class="detail-close" id="about-close">&times;</button>
    <h2>Spectral meets code-first teams</h2>
    <p>A huge share of API teams are <strong>code-first</strong>: they annotate their controllers, handlers, and models, and the OpenAPI is <em>generated</em> from that code on every build. As a Spectral maintainer put it, that workflow "doesn't work with Spectral in any shape or form" — because Spectral lints the spec, and the spec is a build artifact. Any finding you fix by hand-editing the generated file is gone the next time the build runs.</p>
    <p>This tool bridges that gap. Paste the generated OpenAPI and (optionally) your <code>spectral lint -f json</code> output. It <strong>fingerprints the generator</strong> from tell-tale markers, then splits every finding into two piles: the ones <strong>caused by code generation</strong> — missing descriptions, auto operationIds, controller-derived tags, DTO-shaped schema names, generic success-only responses — which can only be fixed <strong>in code</strong>, and genuine <strong>spec-authoring</strong> findings you can fix in the source document.</p>
    <p>For each code-gen finding it tells you the <strong>exact annotation to add</strong> for your generator — a Javadoc / <code>@Operation</code> for springdoc, a docstring or <code>summary=</code> for FastAPI, <code>@ApiOperation</code> for NestJS, and so on.</p>
    <p class="muted small">Generators covered: ${gens.map((g) => esc(g)).join(', ')}. Runs entirely in your browser — nothing you paste leaves the page.</p>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#about-close')!.addEventListener('click', () => el.remove());
  el.querySelector('.about-backdrop')!.addEventListener('click', () => el.remove());
}

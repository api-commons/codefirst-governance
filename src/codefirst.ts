// Code-First Governance Bridge — pure data + knowledge tables. No DOM.
//
// Three capabilities:
//   detectGenerator(doc)          → best-guess OpenAPI generator + confidence + evidence
//   classifyViolations(list)      → split Spectral findings into code-gen-caused vs authoring
//   remediation(ruleCode, gen)    → where in code to fix a code-gen-caused finding
//
// The generator fingerprints, the rule-classification table, and the annotation
// remediation table are all exported constants so they are easy to extend.
import { parse as parseYaml } from 'yaml';

// ---- shared types -----------------------------------------------------------
// A Spectral `lint -f json` result item (same shape the waivers tool consumes).
export interface Violation {
  code: string;
  message?: string;
  path?: (string | number)[];
  severity?: number;
  source?: string;
  range?: any;
}

export type GeneratorId =
  | 'springdoc' | 'fastapi' | 'nestjs' | 'go-swagger' | 'drf-spectacular' | 'tsoa' | 'unknown';

// What kind of fix a finding needs, and which annotation concern it maps to.
export type RuleCategory = 'codegen' | 'authoring';
export type Concern =
  | 'description' | 'summary' | 'operationId' | 'tags' | 'examples' | 'responses' | 'schema-naming';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// ---- parsing ----------------------------------------------------------------
export function parseDoc(text: string): any {
  const t = (text ?? '').trim();
  if (!t) throw new Error('Paste a generated OpenAPI document (YAML or JSON).');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const doc = parseYaml(t);
  if (doc == null || typeof doc !== 'object') throw new Error('That did not parse as an OpenAPI document.');
  return doc;
}

function safeStringify(v: any): string { try { return JSON.stringify(v); } catch { return ''; } }

// A precomputed view of the document that markers test against.
export interface DocContext {
  doc: any;
  raw: string;
  title: string;
  version: string;
  schemaNames: string[];
  tagNames: string[];     // root tags + operation-level tags, de-duped
  operationIds: string[];
  operationCount: number;
}

export function buildContext(doc: any): DocContext {
  const schemas = (doc && (doc.components?.schemas ?? doc.definitions)) || {};
  const schemaNames = Object.keys(schemas);
  const tagSet = new Set<string>();
  if (Array.isArray(doc?.tags)) doc.tags.forEach((t: any) => { if (t?.name) tagSet.add(String(t.name)); });
  const operationIds: string[] = [];
  let operationCount = 0;
  const paths = doc?.paths ?? {};
  for (const item of Object.values(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const [m, op] of Object.entries(item as Record<string, any>)) {
      if (!METHODS.includes(m.toLowerCase())) continue;
      if (!op || typeof op !== 'object') continue;
      operationCount++;
      if (op.operationId) operationIds.push(String(op.operationId));
      if (Array.isArray(op.tags)) op.tags.forEach((t: any) => tagSet.add(String(t)));
    }
  }
  return {
    doc, raw: safeStringify(doc),
    title: String(doc?.info?.title ?? ''),
    version: String(doc?.info?.version ?? ''),
    schemaNames, tagNames: [...tagSet], operationIds, operationCount,
  };
}

// ---- generator fingerprints -------------------------------------------------
export interface GeneratorMarker { label: string; weight: number; test: (c: DocContext) => boolean; }
export interface GeneratorDef {
  id: GeneratorId; name: string; language: string; framework: string; docs: string;
  markers: GeneratorMarker[];
}

export const GENERATORS: GeneratorDef[] = [
  {
    id: 'springdoc', name: 'springdoc / swagger-core', language: 'Java', framework: 'Spring Boot',
    docs: 'https://springdoc.org',
    markers: [
      { label: "info.title is the springdoc default “OpenAPI definition”", weight: 2, test: (c) => c.title === 'OpenAPI definition' },
      { label: 'tags named after `*Controller` classes (e.g. invoice-controller)', weight: 3, test: (c) => c.tagNames.some((t) => /-controller$/i.test(t) || /Controller$/.test(t)) },
      { label: 'operationIds carry `_N` overload suffixes (getInvoices_1)', weight: 3, test: (c) => c.operationIds.some((id) => /_\d+$/.test(id)) },
      { label: 'default server http://localhost:8080', weight: 1, test: (c) => /localhost:8080/.test(c.raw) },
      { label: 'PascalCase `*Dto` DTO schema names', weight: 2, test: (c) => c.schemaNames.some((n) => /^[A-Z].*(Dto|DTO)$/.test(n)) },
    ],
  },
  {
    id: 'fastapi', name: 'FastAPI', language: 'Python', framework: 'FastAPI / Pydantic',
    docs: 'https://fastapi.tiangolo.com',
    markers: [
      { label: 'auto-generated `HTTPValidationError` schema', weight: 3, test: (c) => c.schemaNames.includes('HTTPValidationError') },
      { label: 'Pydantic `ValidationError` schema', weight: 2, test: (c) => c.schemaNames.includes('ValidationError') },
      { label: 'info.title default “FastAPI”', weight: 3, test: (c) => c.title === 'FastAPI' },
      { label: 'operationIds bake in the path (read_users_users__get)', weight: 2, test: (c) => c.operationIds.some((id) => /__[a-z]+$/.test(id) || /__/.test(id)) },
      { label: 'a 422 “Validation Error” response', weight: 1, test: (c) => /"422"/.test(c.raw) && /Validation Error/.test(c.raw) },
    ],
  },
  {
    id: 'nestjs', name: 'NestJS (@nestjs/swagger)', language: 'TypeScript', framework: 'NestJS',
    docs: 'https://docs.nestjs.com/openapi/introduction',
    markers: [
      { label: 'operationIds shaped `Controller_method` (UsersController_findAll)', weight: 3, test: (c) => c.operationIds.some((id) => /^[A-Za-z]\w*Controller_/.test(id)) },
      { label: 'PascalCase controller tag names', weight: 1, test: (c) => c.tagNames.some((t) => /Controller$/.test(t)) },
    ],
  },
  {
    id: 'go-swagger', name: 'go-swagger / swaggo', language: 'Go', framework: 'go-swagger, swaggo/swag',
    docs: 'https://github.com/swaggo/swag',
    markers: [
      { label: 'package-qualified schema names (models.User)', weight: 3, test: (c) => c.schemaNames.some((n) => /^[a-z][\w]*\.[A-Za-z]/.test(n)) },
      { label: '`x-go-package` / `x-go-name` vendor extensions', weight: 3, test: (c) => /x-go-(package|name)/.test(c.raw) },
      { label: 'Swagger 2.0 document', weight: 1, test: (c) => String(c.doc?.swagger ?? '') === '2.0' },
    ],
  },
  {
    id: 'drf-spectacular', name: 'drf-spectacular', language: 'Python', framework: 'Django REST Framework',
    docs: 'https://drf-spectacular.readthedocs.io',
    markers: [
      { label: 'auto `Patched*` write schemas (PatchedUser)', weight: 3, test: (c) => c.schemaNames.some((n) => /^Patched[A-Z]/.test(n)) },
      { label: 'operationIds end in DRF actions (_list, _create, _partial_update)', weight: 3, test: (c) => c.operationIds.some((id) => /_(list|create|retrieve|update|partial_update|destroy)$/.test(id)) },
      { label: 'split `*Request` component schemas', weight: 1, test: (c) => c.schemaNames.some((n) => /Request$/.test(n)) && c.schemaNames.some((n) => !/Request$/.test(n)) },
    ],
  },
  {
    id: 'tsoa', name: 'tsoa', language: 'TypeScript', framework: 'tsoa',
    docs: 'https://tsoa-community.github.io/docs/',
    markers: [
      { label: '`tsoa` marker in the document', weight: 3, test: (c) => /tsoa/i.test(c.raw) },
      { label: 'controller-method operationIds', weight: 1, test: (c) => c.operationIds.some((id) => /Controller_/.test(id)) },
    ],
  },
];

export interface RankedGenerator { id: GeneratorId; name: string; language: string; framework: string; score: number; evidence: string[]; }
export interface DetectResult {
  generator: GeneratorId; name: string; language: string; framework: string; docs: string;
  confidence: number; evidence: string[]; ranked: RankedGenerator[];
}

// Fingerprint the likely generator. Accepts a parsed OpenAPI object.
export function detectGenerator(doc: any): DetectResult {
  const ctx = buildContext(doc);
  const ranked: RankedGenerator[] = GENERATORS.map((g) => {
    const evidence: string[] = [];
    let score = 0;
    for (const m of g.markers) {
      try { if (m.test(ctx)) { score += m.weight; evidence.push(m.label); } } catch { /* ignore bad marker */ }
    }
    return { id: g.id, name: g.name, language: g.language, framework: g.framework, score, evidence };
  }).sort((a, b) => b.score - a.score);

  const win = ranked[0];
  const runnerUp = ranked[1]?.score ?? 0;
  if (!win || win.score === 0) {
    return {
      generator: 'unknown', name: 'Unknown / hand-authored', language: '—', framework: '—',
      docs: '', confidence: 0, evidence: [], ranked,
    };
  }
  // Confidence is relative: a strong winner over a weak field scores high.
  const confidence = win.score / (win.score + runnerUp + 1);
  const def = GENERATORS.find((g) => g.id === win.id)!;
  return {
    generator: win.id, name: win.name, language: win.language, framework: win.framework, docs: def.docs,
    confidence, evidence: win.evidence, ranked,
  };
}

// ---- rule classification ----------------------------------------------------
export interface RuleClass { title: string; category: RuleCategory; concern?: Concern; reason: string; }

// The knowledge table: which Spectral rule codes are typically CAUSED by code
// generation (and so can't be fixed by editing the regenerated spec) vs. which
// are genuine spec-authoring / config findings. Extend freely.
export const RULE_CLASSIFICATION: Record<string, RuleClass> = {
  // ---- code-generation-caused (fix the annotation, then regenerate) ----
  'operation-description': { title: 'Operation missing description', category: 'codegen', concern: 'description', reason: 'Descriptions come from doc comments / decorators in code — editing the spec is overwritten on the next generate.' },
  'operation-summary': { title: 'Operation missing summary', category: 'codegen', concern: 'summary', reason: 'Summaries are derived from the method doc/annotation, not authored in the spec.' },
  'operation-operationId': { title: 'Operation missing operationId', category: 'codegen', concern: 'operationId', reason: 'operationId is auto-derived from the method; set it in code or configure the id strategy.' },
  'operation-operationId-unique': { title: 'Duplicate operationId', category: 'codegen', concern: 'operationId', reason: 'Overloaded / same-named handlers collide (springdoc appends _N). Fix the method names or ids in code.' },
  'operation-operationId-valid-in-url': { title: 'operationId not URL-safe', category: 'codegen', concern: 'operationId', reason: 'The generated id contains characters from the method name; rename in code.' },
  'operation-tags': { title: 'Operation missing tags', category: 'codegen', concern: 'tags', reason: 'Tags are derived from the controller class; add the tag annotation in code.' },
  'operation-tag-defined': { title: 'Tag not defined at root', category: 'codegen', concern: 'tags', reason: 'Root tag list + descriptions come from class-level annotations / app config.' },
  'tag-description': { title: 'Tag missing description', category: 'codegen', concern: 'tags', reason: 'Tag descriptions come from the controller-level annotation, not the spec.' },
  'openapi-tags-alphabetical': { title: 'Tags not ordered', category: 'codegen', concern: 'tags', reason: 'Tag order follows controller discovery order in code, not the spec.' },
  'operation-success-response': { title: 'No documented success response', category: 'codegen', concern: 'responses', reason: 'Generators emit only the handler return type; declare the full response set in annotations.' },
  'operation-2xx-response': { title: 'Missing 2xx response', category: 'codegen', concern: 'responses', reason: 'Only the inferred success/status code is emitted; declare responses in code.' },
  'oas3-valid-media-example': { title: 'Missing / invalid media example', category: 'codegen', concern: 'examples', reason: 'Examples come from schema/field annotations; add them in code.' },
  'oas3-valid-schema-example': { title: 'Missing / invalid schema example', category: 'codegen', concern: 'examples', reason: 'Field examples are annotation-driven; add them on the model in code.' },
  'oas2-valid-media-example': { title: 'Missing / invalid media example', category: 'codegen', concern: 'examples', reason: 'Examples come from schema/field annotations; add them in code.' },
  'oas2-valid-schema-example': { title: 'Missing / invalid schema example', category: 'codegen', concern: 'examples', reason: 'Field examples are annotation-driven; add them on the model in code.' },
  'schema-naming-convention': { title: 'Generator-shaped schema name', category: 'codegen', concern: 'schema-naming', reason: 'Component names mirror your class names (Dto/Request/Patched/package-qualified); rename or annotate the type in code.' },

  // ---- spec-authoring / generator-config (do NOT need a code annotation) ----
  'info-contact': { title: 'Info missing contact', category: 'authoring', reason: 'Set once in your generator/app config or the base document; not per-handler code.' },
  'info-description': { title: 'Info missing description', category: 'authoring', reason: 'Project-level metadata; set in generator config or a base OpenAPI file.' },
  'info-license': { title: 'Info missing license', category: 'authoring', reason: 'Project-level metadata; set in generator config.' },
  'license-url': { title: 'License missing URL', category: 'authoring', reason: 'Project-level metadata.' },
  'contact-properties': { title: 'Contact incomplete', category: 'authoring', reason: 'Project-level metadata.' },
  'oas3-schema': { title: 'Structurally invalid OpenAPI', category: 'authoring', reason: 'A structural error — usually a generator bug or overlay; fix the structure, not an annotation.' },
  'oas2-schema': { title: 'Structurally invalid Swagger', category: 'authoring', reason: 'A structural error; fix the structure, not an annotation.' },
  'oas3-unused-component': { title: 'Unused component', category: 'authoring', reason: 'Dead schema — trim it in code or ignore; not an annotation fix.' },
  'no-$ref-siblings': { title: '$ref has siblings', category: 'authoring', reason: 'A spec-shape issue, typically post-processing/overlay.' },
  'duplicated-entry-in-enum': { title: 'Duplicate enum entry', category: 'authoring', reason: 'Data-modeling issue in the enum definition.' },
  'typed-enum': { title: 'Enum value wrong type', category: 'authoring', reason: 'Type mismatch in the enum definition.' },
  'path-keys-no-trailing-slash': { title: 'Trailing slash in path', category: 'authoring', reason: 'Routing convention; fix at the route/config level.' },
  'path-declarations-must-exist': { title: 'Undeclared path parameter', category: 'authoring', reason: 'Path template issue.' },
  'no-eval-in-markdown': { title: 'eval in markdown', category: 'authoring', reason: 'Content hygiene in a description string.' },
  'no-script-tags-in-markdown': { title: 'script tag in markdown', category: 'authoring', reason: 'Content hygiene in a description string.' },
  'oas3-server-trailing-slash': { title: 'Server URL trailing slash', category: 'authoring', reason: 'Set in generator/app server config.' },
};

const UNKNOWN_REASON = 'Not a recognized code-generation pattern — treat as a spec-authoring finding until classified.';

export interface ClassifiedViolation extends Violation {
  title: string;
  category: RuleCategory;
  concern?: Concern;
  reason: string;
  known: boolean;
}
export interface ClassifyResult {
  codegen: ClassifiedViolation[];
  authoring: ClassifiedViolation[];
  byConcern: Partial<Record<Concern, ClassifiedViolation[]>>;
  counts: { total: number; codegen: number; authoring: number; unknown: number };
}

// Split a list of Spectral findings into the code-gen-caused subset and the
// spec-authoring subset, using RULE_CLASSIFICATION.
export function classifyViolations(violations: Violation[]): ClassifyResult {
  const codegen: ClassifiedViolation[] = [];
  const authoring: ClassifiedViolation[] = [];
  const byConcern: Partial<Record<Concern, ClassifiedViolation[]>> = {};
  let unknown = 0;

  for (const v of violations) {
    const rc = RULE_CLASSIFICATION[v.code];
    const known = !!rc;
    if (!known) unknown++;
    const cv: ClassifiedViolation = {
      ...v,
      title: rc?.title ?? v.code,
      category: rc?.category ?? 'authoring',
      concern: rc?.concern,
      reason: rc?.reason ?? UNKNOWN_REASON,
      known,
    };
    if (cv.category === 'codegen') {
      codegen.push(cv);
      if (cv.concern) (byConcern[cv.concern] ??= []).push(cv);
    } else {
      authoring.push(cv);
    }
  }

  return {
    codegen, authoring, byConcern,
    counts: { total: violations.length, codegen: codegen.length, authoring: authoring.length, unknown },
  };
}

// ---- annotation remediation -------------------------------------------------
type ConcernRemediation = Partial<Record<GeneratorId, string>> & { default: string };

// For each code-gen concern, WHERE in code to fix it, per detected generator.
export const REMEDIATION_TABLE: Record<Concern, ConcernRemediation> = {
  description: {
    default: 'This description originates in your code, not the spec. Find the handler that produced this path and add its documentation, then regenerate.',
    springdoc: 'Add a Javadoc comment on the controller method, or `@Operation(description = "…")` (swagger-core). springdoc reads both.',
    fastapi: 'Add a docstring to the path-operation function, or pass `description="…"` in the route decorator (`@app.get(..., description=...)`).',
    nestjs: 'Add `@ApiOperation({ description: "…" })` above the controller handler.',
    'go-swagger': 'Add a `// @Description …` annotation (swaggo) on the handler, then run `swag init`.',
    'drf-spectacular': 'Add a docstring to the view/viewset method, or use `@extend_schema(description="…")`.',
    tsoa: 'Add a JSDoc block above the controller method; tsoa maps the leading text into the description.',
  },
  summary: {
    default: 'Summaries are derived from the method’s doc/annotation. Add a short one-line summary in code and regenerate.',
    springdoc: 'Add `@Operation(summary = "…")` on the controller method (the first Javadoc line is used if present).',
    fastapi: 'Pass `summary="…"` in the route decorator, or rely on the first line of the function docstring.',
    nestjs: 'Add `@ApiOperation({ summary: "…" })` on the handler.',
    'go-swagger': 'Add a `// @Summary …` annotation (swaggo) on the handler.',
    'drf-spectacular': 'Use `@extend_schema(summary="…")` on the view method.',
    tsoa: 'The first line of the method’s JSDoc becomes the summary — add one.',
  },
  operationId: {
    default: 'operationId is auto-derived from the method. Set an explicit, unique id in code or configure the id-generation strategy.',
    springdoc: 'springdoc appends `_1`, `_2` to overloaded methods. Rename the Java methods to be unique, or set `@Operation(operationId = "…")`.',
    fastapi: 'Set `operation_id="…"` on the route, or configure `generate_unique_id_function` on the app for stable, unique ids.',
    nestjs: 'Set `@ApiOperation({ operationId: "…" })`; the default is `Controller_method`.',
    'go-swagger': 'Add `// @ID <uniqueName>` (swaggo) to each handler.',
    'drf-spectacular': 'Set `@extend_schema(operation_id="…")`; defaults are built from the URL + action.',
    tsoa: 'Give methods unique names, or set `@OperationId("…")`; tsoa defaults to `ClassName_methodName`.',
  },
  tags: {
    default: 'Tags are derived from the controller/class. Set a clean, human tag name (and description) via the tag annotation in code.',
    springdoc: 'Tag defaults to the kebab-cased controller (`invoice-controller`). Add `@Tag(name = "Invoices", description = "…")` on the controller.',
    fastapi: 'Pass `tags=["Invoices"]` on the router/route, and register descriptions via `openapi_tags` on the app.',
    nestjs: 'Add `@ApiTags("Invoices")` on the controller; the default tag is the controller class name.',
    'go-swagger': 'Add `// @Tags invoices` on the handler.',
    'drf-spectacular': 'Use `@extend_schema(tags=["Invoices"])` (or `@extend_schema_view`).',
    tsoa: 'Add `@Tags("Invoices")` on the controller.',
  },
  examples: {
    default: 'Examples come from schema/field annotations. Add them on the model or media type in code and regenerate.',
    springdoc: 'Add `@Schema(example = "…")` on the DTO field, or `@ExampleObject` inside `@Content`.',
    fastapi: 'Add `Field(..., examples=[…])` on the Pydantic model, or `json_schema_extra={"example": …}`.',
    nestjs: 'Add `example:` to `@ApiProperty({ example: … })` on the DTO field.',
    'go-swagger': 'Add an `example:"…"` struct tag (swaggo) on the field.',
    'drf-spectacular': 'Provide `OpenApiExample(…)` via `@extend_schema(examples=[…])`.',
    tsoa: 'Use `@Example<T>({ … })` on the model or method.',
  },
  responses: {
    default: 'Generators emit only the inferred success response. Declare the full set of status codes and error shapes in annotations.',
    springdoc: 'Declare `@ApiResponses` / `@ApiResponse(responseCode = "404", …)`; only the success type is emitted by default.',
    fastapi: 'Add `responses={404: {…}}` on the route and set the success `status_code=`.',
    nestjs: 'Add `@ApiResponse({ status: 404, … })` per status; only the handler return type is documented by default.',
    'go-swagger': 'Add `// @Success` and `// @Failure` annotations per status (swaggo).',
    'drf-spectacular': 'Use `@extend_schema(responses={200: …, 404: …})`.',
    tsoa: 'Use `@SuccessResponse` and `@Response<T>(404, "…")` on the method.',
  },
  'schema-naming': {
    default: 'Component names mirror your code type names. Rename the type, or annotate a clean schema name, then regenerate.',
    springdoc: 'Names come from Java classes (`InvoiceDto`). Rename the class, or set `@Schema(name = "Invoice")` on it.',
    fastapi: 'Names are the Pydantic model class names. Rename the model, or set `model_config = ConfigDict(title="Invoice")`.',
    nestjs: 'Names come from the DTO class — rename it (or manage ids via `@ApiExtraModels`).',
    'go-swagger': 'swaggo uses package-qualified struct names (`models.Invoice`). Rename the struct or set a `swaggertype`.',
    'drf-spectacular': 'Names come from serializers and gain `Request`/`Patched` variants — rename serializers or tune `COMPONENT_SPLIT_REQUEST`.',
    tsoa: 'Names are your TS interface/class names — rename the type.',
  },
};

export interface RemediationResult {
  ruleCode: string;
  concern: Concern | null;
  generator: GeneratorId;
  guidance: string;
  applies: boolean; // false when the finding is a spec-authoring one (no code annotation fixes it)
}

// Given a Spectral rule code and a detected generator, return where-in-code guidance.
export function remediation(ruleCode: string, generator: GeneratorId): RemediationResult {
  const rc = RULE_CLASSIFICATION[ruleCode];
  if (!rc || rc.category !== 'codegen' || !rc.concern) {
    return {
      ruleCode, concern: rc?.concern ?? null, generator, applies: false,
      guidance: 'This is a spec-authoring / generator-config finding — fix it in the source document or your generator configuration, not with a per-handler code annotation.',
    };
  }
  const table = REMEDIATION_TABLE[rc.concern];
  return { ruleCode, concern: rc.concern, generator, applies: true, guidance: table[generator] ?? table.default };
}

// ---- built-in checklist -----------------------------------------------------
// When no Spectral output is supplied, derive the common code-gen-caused
// findings directly from the generated document so the tool still has something
// to classify and remediate.
function mk(code: string, path: (string | number)[], message: string): Violation {
  return { code, message, severity: 1, source: '(built-in checklist)', path };
}

export function builtinChecklist(doc: any): Violation[] {
  const out: Violation[] = [];
  const paths = doc?.paths ?? {};
  for (const [pth, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const [m, op] of Object.entries(item as Record<string, any>)) {
      if (!METHODS.includes(m.toLowerCase())) continue;
      if (!op || typeof op !== 'object') continue;
      const base: (string | number)[] = ['paths', pth, m];
      if (!op.description) out.push(mk('operation-description', [...base, 'description'], 'Operation must have a description.'));
      if (!op.summary) out.push(mk('operation-summary', [...base, 'summary'], 'Operation should have a summary.'));
      if (!op.operationId) out.push(mk('operation-operationId', [...base], 'Operation must have an operationId.'));
      if (!Array.isArray(op.tags) || op.tags.length === 0) out.push(mk('operation-tags', [...base, 'tags'], 'Operation must have tags.'));
      const responses = op.responses ?? {};
      const codes = Object.keys(responses);
      const onlySuccess = codes.length > 0 && codes.every((c) => /^[12]/.test(c) || c === 'default');
      if (onlySuccess) out.push(mk('operation-success-response', [...base, 'responses'], 'Only success responses documented; error responses missing.'));
    }
  }
  // Generator-shaped schema names → schema-naming concern.
  const schemas = (doc && (doc.components?.schemas ?? doc.definitions)) || {};
  for (const name of Object.keys(schemas)) {
    if (/(Dto|DTO|VO|Request|Response)$/.test(name) || /^Patched[A-Z]/.test(name) || /^[a-z][\w]*\.[A-Za-z]/.test(name)) {
      const loc: (string | number)[] = doc?.components?.schemas ? ['components', 'schemas', name] : ['definitions', name];
      out.push(mk('schema-naming-convention', loc, `Schema “${name}” is shaped by the code generator.`));
    }
  }
  return out;
}

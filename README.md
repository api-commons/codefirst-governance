# Code-First Governance Bridge

**A browser-first tool that meets code-first API teams where they are — fingerprint the OpenAPI generator from a generated spec, separate the governance findings you must fix *in code* from the ones you can fix in the spec, and map each code-gen finding to the exact annotation that fixes it.**

No backend, no accounts; runs entirely in your browser. Live at **[codefirst.apicommons.org](https://codefirst.apicommons.org)**.

## Why this exists

A huge share of API teams are **code-first**: they annotate controllers, handlers, and models, and their OpenAPI is *generated* from that code on every build. The [State-of-Spectral](https://github.com/api-commons/spectral-reporter) research surfaced a blunt point from a Spectral maintainer — for these teams Spectral "doesn't work in any shape or form," because Spectral lints the **spec**, and the spec is a build artifact. Any finding you "fix" by hand-editing the generated file is **overwritten on the very next build**.

That is the gap this tool bridges. It does not replace Spectral — it makes Spectral usable for code-first teams by answering the question Spectral can't: *of these findings, which ones can I even fix here, and which have to go back into the code?* And for the ones that go back into the code, *what exactly do I add, and where?*

## What it reports

Paste the generated OpenAPI (YAML or JSON) and, optionally, your `spectral lint -f json` output — leave it empty to run the built-in checklist derived from the document. It gives you:

- **Detected generator** — a best-guess of the framework/generator (springdoc / swagger-core, FastAPI, NestJS, go-swagger / swaggo, drf-spectacular, tsoa) with a **confidence score** and the **evidence** that triggered it (controller-suffixed tags, `_N` overload operationIds, `HTTPValidationError`, `Patched*` schemas, package-qualified names, and more). The knowledge lives in an extensible fingerprint table.
- **Fix-in-code vs. fix-in-spec** — every finding is split into the subset **caused by code generation** (missing descriptions/summaries, auto or duplicate operationIds, controller-derived tags, generic success-only responses, missing examples, DTO-shaped schema names) versus genuine **spec-authoring / config** findings, using a rule-classification table.
- **Annotation-level remediation** — for each code-gen finding, the **exact annotation to add** for the detected generator (a Javadoc / `@Operation` for springdoc, a docstring or `summary=` for FastAPI, `@ApiOperation` for NestJS, `// @Description` for swaggo, `@extend_schema` for drf-spectacular, JSDoc for tsoa). Download it as a per-finding **code-fix worklist** to hand to the team that owns the code.

The pure-data core lives in [`src/codefirst.ts`](src/codefirst.ts): `detectGenerator(doc)`, `classifyViolations(violations)`, and `remediation(ruleCode, generator)`, plus the exported `GENERATORS`, `RULE_CLASSIFICATION`, and `REMEDIATION_TABLE` knowledge tables — all DOM-free and easy to extend.

## Develop

```bash
npm install
npm run dev
npm run build     # → dist/
```

Pure client-side; no data build. The samples in `public/` are a springdoc-generated spec and matching Spectral output.

## Privacy

Everything runs client-side. The OpenAPI and lint results you paste never leave the page — there is no server.

---

Part of the [API Commons](https://apicommons.org/tools/) governance tools, alongside
[Governance Coverage](https://github.com/api-commons/governance-coverage),
[Governance Waivers](https://github.com/api-commons/governance-waivers),
[API Validator](https://github.com/api-commons/api-validator),
[Spectral Ruleset Studio](https://github.com/api-commons/spectral-ruleset-studio), and the
[API Governance Graph](https://github.com/api-commons/api-governance-graph).

A project of [API Evangelist](https://apievangelist.com), maintained openly under
[API Commons](https://apicommons.org). Free to fork; API Evangelist offers expert API
governance services — including standing up governance for code-first teams — when you want
help. Apache-2.0.

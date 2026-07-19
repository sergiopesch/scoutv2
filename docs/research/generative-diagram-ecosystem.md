# Diagram generation ecosystem catalogue

**Research date:** 2026-07-19

**Purpose:** compare current diagram, layout and AI-generation options for Scout
V2. This catalogue is not an implementation or procurement decision.

## Decision matrix

Scores are relative to Scout's live, browser-rendered, evidence-grounded meeting
use case: 5 is strongest. “Continuity” means ability to retain a viewer's mental
map as revisions arrive.

| Candidate | Open deployment | Diagram semantics | Live/browser fit | Continuity | Scout role |
|---|---:|---:|---:|---:|---|
| Mermaid 11.16 | 5 | 3 | 5 | 2 | MVP production target and fallback |
| React Flow + ELK.js | 5 | 4 | 5 | 4 | strongest open retained-canvas candidate |
| yFiles for HTML | 1 | 5 | 5 | 5 | commercial quality benchmark |
| Cytoscape.js + ELK/fCoSE | 5 | 3 | 5 | 4 | relationship/dependency maps |
| AntV G6 | 5 | 3 | 5 | 4 | high-performance arbitrary graphs |
| bpmn-js | 4 | 5 for BPMN | 4 | 3 | standards-compliant process artifact |
| Structurizr/C4 | 3 | 5 for architecture | 3 | 2 | architecture model/view projection |
| D2 | 4 | 4 | 3 | 2 | polished architecture/export artifact |
| Graphviz | 5 | 4 | 2 | 2 | static layout/export benchmark |
| GoJS | 1 | 5 | 5 | 4 | commercial turnkey editor benchmark |
| maxGraph | 5 | 4 | 4 | 3 | open editable diagram canvas |
| JointJS | 3 | 4 | 4 | 3 | enterprise editor option |
| Sprotty + ELK | 5 | 5 | 4 | 4 | sophisticated model-driven editor |
| Kroki | 5 | varies | 2 | 1 | self-hosted multi-format evaluation/export |
| PlantUML | 3 | 5 for UML | 2 | 1 | UML compatibility/export |

The table reinforces one architectural separation:

```text
semantic accuracy ≠ projection quality ≠ layout quality ≠ renderer quality
```

## Recommended shortlist

### Refine now: Mermaid 11.16

Mermaid is MIT-licensed, already installed, browser-native and easy to inspect,
validate, render and export. Scout is using far less than the installed version
offers.

Relevant primary documentation:

- [JavaScript API and rendering](https://mermaid.js.org/config/usage)
- [Layout selection](https://mermaid.js.org/config/layouts.html)
- [Swimlanes](https://mermaid.js.org/syntax/swimlanes.html)
- [Architecture diagrams](https://mermaid.js.org/syntax/architecture.html)
- [Flowcharts](https://mermaid.js.org/syntax/flowchart.html)

Use Mermaid as a deterministic compiler target, not as the semantic model. Its
main limitation is that a full render is a fresh compilation: it does not
naturally preserve node positions across revisions.

### Best open future stack: React Flow + ELK.js

[React Flow](https://reactflow.dev/) is an MIT-licensed retained graph/editor
shell with custom nodes, viewport control and incremental interaction. Automatic
layout is intentionally external; its own
[layout guide](https://reactflow.dev/learn/layouting/layouting) compares Dagre,
D3 hierarchy and ELK.

[ELK.js](https://github.com/kieler/elkjs) exposes Eclipse Layout Kernel
algorithms to JavaScript and can run in a Web Worker. The
[layered algorithm](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html)
supports directed graphs, ports, compound nodes, cross-hierarchy edges and
orthogonal/spline routing. ELK returns positions; it is not itself a renderer.

This pairing is the strongest open candidate for:

- stable retained elements;
- animation from old to new coordinates;
- explicit containers and ports;
- preserved zoom and pan;
- off-main-thread layout.

It still requires stable IDs, stable ordering, prior-position constraints,
fixed options/seeds and per-diagram layout profiles. ELK is not automatically
stable merely because it is sophisticated.

### Quality ceiling: yFiles for HTML

yFiles is commercial, but its
[incremental layout](https://docs.yworks.com/yfiles-html/dguide/layout-incremental_layout/)
directly addresses Scout's central visual problem: lay out new or changed items
while preserving the existing mental map. Its
[hierarchical layout](https://docs.yworks.com/yfiles-html/dguide/hierarchical_layout/)
also supports constraints, groups, ports, routing and labeling.

Use an evaluation license as a benchmark. A production choice would need a
separate cost, deployment and licensing review; see
[yFiles pricing](https://www.yfiles.com/pricing).

## General graph and editor candidates

### Cytoscape.js

[Cytoscape.js](https://js.cytoscape.org/) is MIT-licensed and strong for
compound relationship, stakeholder, capability, dependency and knowledge
graphs. It has headless operation, animation and layout extensions including
ELK, Dagre, fCoSE and Cola. It is less naturally semantic for BPMN-like process
rules or architecture boundaries.

### AntV G6 and X6

[G6](https://g6.antv.antgroup.com/en/manual/layout/overview) supports
Canvas/SVG/WebGL, worker-friendly layouts and animation. Its
[AntV Dagre layout](https://g6.antv.antgroup.com/en/manual/layout/antv-dagre-layout)
can use preset positions, which is useful for continuity. It is a promising
large arbitrary-graph renderer.

[X6](https://github.com/antvis/X6) is an MIT SVG/HTML editor with strong custom
nodes and ports. It normally relies on separate layout logic.

### Dagre

[Dagre](https://github.com/dagrejs/dagre) is a fast MIT directed layered-layout
library. It is a good profile for small and medium simple flows, but it provides
fewer compound-graph constraints than ELK.

### maxGraph

[maxGraph](https://maxgraph.github.io/maxGraph/docs/intro/) is the
Apache-2.0 TypeScript successor to mxGraph/draw.io's core. It offers SVG,
grouping, ports, swimlanes, editing and several layouts. It is attractive if
Scout later needs a full open editor, but is more machinery than the current
presentation-only MVP needs.

### JointJS and GoJS

[JointJS](https://www.jointjs.com/) has an MPL-2.0 core; advanced JointJS+
capabilities are commercial. See its [license](https://www.jointjs.com/license).
It is a mature SVG editor but would represent a substantial shell change.

[GoJS](https://gojs.net/latest/) is a polished commercial diagramming toolkit
with tree, layered, force and circular layouts plus transactions and animation.
It is a useful turnkey benchmark rather than the default open path.

### Sprotty

[Sprotty](https://sprotty.org/docs/introduction/) is an EPL-2.0 model-driven SVG
framework with an external model protocol, incremental updates and ELK
integration. Its architecture is powerful for language tooling and complex
editors, but likely too elaborate for the MVP.

### MSAGL.js

[MSAGL.js](https://microsoft.github.io/msagljs/docs/intro/) brings Microsoft's
graph layout to the browser, including Sugiyama, MDS, IPSepCola and several edge
routing modes. It is a useful emerging benchmark, particularly for larger
graphs, but has a smaller Scout-relevant integration ecosystem than ELK.

### Sigma.js and vis-network

[Sigma.js](https://www.sigmajs.org/docs/) is a WebGL renderer for very large
Graphology-based networks. [vis-network](https://visjs.github.io/vis-network/docs/)
is a convenient Canvas network visualizer. Both suit exploratory networks more
than formal process, organisation or architecture diagrams; physics-based
stabilization can also make live diagrams visibly jump.

## Specialized artifact candidates

### BPMN: bpmn-js

[bpmn-js](https://bpmn.io/toolkit/bpmn-js/walkthrough/) is the appropriate
browser viewer/modeler when standards-compliant BPMN 2.0 XML matters. Its open
license requires a visible bpmn.io attribution; see
[the licensing explanation](https://bpmn.io/license/).

It should be an explicit finalized/export view, not Scout's canonical model or
the renderer for every live turn. BPMN auto-layout does not remove the harder
problem of correctly extracting participants, gateways, message flows,
conditions and events from speech.

### Architecture: Structurizr/C4

[Structurizr DSL](https://docs.structurizr.com/dsl) cleanly separates an
architecture model from multiple views and can export to other formats. Scout
should borrow that model/view principle. Structurizr is not a generic process or
org-chart renderer and need not become Scout's source of truth.

### Architecture and exports: D2

[D2](https://d2lang.com/tour/intro/) is an MPL-2.0 diagram DSL with
[Dagre, ELK and TALA layout options](https://d2lang.com/tour/layouts/). It
produces polished architecture artifacts and broad exports. Browser/WASM use is
less direct than Mermaid, and small text changes can cascade into different
layout, which is undesirable in a live meeting. It is stronger as a post-meeting
artifact/export benchmark.

### Static layout: Graphviz

[Graphviz](https://graphviz.org/) remains a mature ranked/clustered static graph
layout and export benchmark. The [DOT layout](https://graphviz.org/docs/layouts/dot/)
is excellent for directed graphs. It has a weaker interactive browser hot path
and continuity story than retained-canvas options.

### UML compatibility: PlantUML

[PlantUML](https://plantuml.com/) supports a very broad UML and non-UML family,
with several layout/runtime choices. Java/server complexity, verbose syntax and
license/distribution variants make it a compatibility or export choice rather
than Scout's primary live path.

### Multi-engine gateway: Kroki

[Kroki](https://docs.kroki.io/kroki/) provides a self-hostable HTTP API across
Mermaid, Graphviz, D2, PlantUML, Structurizr and other diagram engines. It is
useful for evaluation and export. Putting a network service between every
utterance and the live board would add latency and operational failure modes
without improving semantic extraction.

### Sketch mode: Excalidraw

[Excalidraw](https://github.com/excalidraw/excalidraw) offers a familiar
hand-drawn editable canvas and Mermaid conversion. It could become an optional
presentation mode, not the core semantic or formal-diagram path.

## Generative-AI product benchmarks

These products validate the market demand and offer UX inspiration. They should
not become canonical truth or receive confidential Scout transcript data in the
hot path.

| Product | Relevant pattern | Primary source |
|---|---|---|
| Mermaid Chart AI | prompt-to-Mermaid, conversational edit, validate/repair | [AI diagrams](https://mermaid.ai/docs/getting-started/generate-diagram-with-ai) |
| Eraser DiagramGPT | diagram-type-specific generation and an external generation API | [AI diagrams](https://docs.eraser.io/docs/ai-diagrams), [API](https://docs.eraser.io/reference/generate-diagram-from-prompt) |
| Lucid AI | editable flow, swimlane, ERD, architecture, network, BPMN and UML generation | [Lucid AI features](https://lucid.co/blog/lucid-ai-features) |
| Miro AI | editable diagrams/mind maps and Mermaid workflows | [Miro AI diagrams](https://help.miro.com/hc/en-us/articles/28782102127890-Miro-AI-with-Diagrams-and-mindmaps) |
| Whimsical MCP | separate create, edit and auto-layout operations | [MCP tools](https://whimsical.com/learn/ai/mcp-tools) |

The recurring product pattern is sound:

- generate structured editable objects, not a bitmap;
- separate semantic create/edit from layout;
- use diagram-type-specific grammars;
- validate and repair malformed output;
- preserve editability and stable identities.

Scout should implement these principles deterministically around its accepted
graph rather than add another unconstrained LLM call.

## Relevant semantic and evaluation research

### Structured generation is necessary but not sufficient

OpenAI's [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs)
states the key boundary: schema adherence does not eliminate semantic errors.
Examples, decomposition and application-level validation remain important.

The Codex app-server supports a per-turn output schema; see
[app-server turns](https://learn.chatgpt.com/docs/app-server#turns). Scout's
current use of this capability is sound.

### Separate extraction, schema and canonicalization

The paper [Extract, Define, Canonicalize](https://aclanthology.org/2024.emnlp-main.548/)
supports a useful mental model: entity/relation extraction, schema alignment and
canonicalization are distinct jobs. Scout need not add multiple runtime calls to
apply that separation in its instructions and deterministic validation.

### Evaluate diagrams as graphs and paths

[DiagramEval](https://aclanthology.org/2025.emnlp-main.640/) evaluates generated
diagrams with node and path alignment rather than relying only on text or image
similarity. This is directly applicable to transcript-to-graph revisions.

### Borrow provenance and temporal ideas without adding a graph database

[W3C PROV](https://www.w3.org/TR/prov-o/) provides a vocabulary for provenance.
[SHACL](https://www.w3.org/TR/shacl/) demonstrates deterministic graph
constraints. [Graphiti](https://help.getzep.com/graphiti/getting-started/overview)
shows episode provenance, temporal validity and typed entities for evolving
knowledge graphs. Scout can borrow support/contradiction, validity and typed
constraint patterns while remaining in its in-memory, complete-graph MVP.

## Live-layout stability checklist

Any renderer that advances beyond research should satisfy all of these:

- immutable semantic IDs independent of mutable labels;
- stable input, group and sibling order;
- prior position/order supplied to layout when supported;
- pinned or semi-pinned retained elements where appropriate;
- fixed layout options, fonts and random seed;
- per-kind orientation, routing and spacing;
- node sizing after deterministic label wrapping;
- edge routing after node placement;
- orthogonal routing for process/architecture, simpler curves for networks;
- initial fit only, then preserved pan/zoom;
- fade/animate new and retained elements without hiding the content change;
- stale valid view retained on parse, layout or render failure.

## Procurement and architecture interpretation

- **No new production dependency is justified yet.** Mermaid 11.16 contains the
  first set of improvements Scout should measure.
- **React Flow + ELK.js** is the preferred open technical experiment if a
  retained canvas is later warranted.
- **yFiles** should define the benchmark, not the initial architecture.
- **bpmn-js and Structurizr/D2** are format-specific projections or exports, not
  replacements for `BusinessGraph`.
- **AI diagram SaaS** is useful for UX comparison and offline benchmarking, not
  for confidential live generation.
- Every licensing statement needs fresh counsel/procurement validation before a
  production commitment; this catalogue is technical research, not legal
  advice.

## Primary conclusion

The library search does not reveal a magic “speech to perfect diagram” component.
The sustainable system is a stack of independently testable layers:

```text
speech fidelity
  → evidence-grounded semantic extraction
  → identity/correction/provenance rules
  → deterministic view projection
  → diagram-appropriate layout
  → reliable renderer and viewport continuity
```

Scout already has the transport, canonical replacement and atomic rendering
foundations. Its next breakthrough should come from making the semantic and
projection layers explicit, then using objective replays to determine whether a
renderer migration is actually necessary.

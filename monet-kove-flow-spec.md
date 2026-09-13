# Monet + Kove — Full Flow Spec (Login → Export)

Purpose: give a build-agent an unambiguous, end-to-end map of what the user does, what Monet (AI director) does, and what Kove (editor) does at every stage. No feature is implied unless listed here.

---

## 1. Actors

| Actor | Role |
|---|---|
| **User** | Uploads source material, gives intent (prompt/genre), reviews AI output, optionally takes manual control |
| **Monet** | AI director. Owns: frame analysis orchestration, prompt interpretation, EDL authoring, effect/transition/text decisions |
| **Python frame worker** | Extracts frames at a decided sample rate, batches them into carousels for vision scoring |
| **Kove (Simple)** | Chat-first surface. User sees Monet's output as a finished-looking edit, not a timeline |
| **Kove-Advanced** | Full timeline editor. Either Monet or the user can be "at the wheel" |
| **render-worker / apps/api / apps/python-effects** | Existing backend subsystems that execute the EDL (per effects-pipeline notes) |

---

## 2. High-Level Flowchart

```mermaid
flowchart TD
    A[User logs in] --> B["Dashboard: chat box\n'Ready to kreate, {Username}?'"]
    B --> C[Upload: video(s) + optional music/images/brief files]
    C --> D{Prompt given}
    D -->|Detailed prompt OR genre selected| F[Skip Q&A]
    D -->|Vague prompt, no genre| E[Monet asks clarifying questions]
    E --> F
    F --> G[Ingest: Python worker extracts frames]
    G --> H[Frame carousels sent to vision model in batches]
    H --> I[Monet builds shot/segment map:\nchop long-form into feasible sections,\npreserve topic intent + prompt intent]
    I --> J[Monet authors EDL:\ncuts, placement, overlays,\neffects, transitions, text + type props]
    J --> K[Kove-Advanced renders Monet's draft\n(user is viewing, not required to touch it)]
    K --> L{User action}
    L -->|Accept / export as-is| M[Export]
    L -->|Refine via chat| I
    L -->|"Jump to Advanced"| N[User takes manual control of Kove-Advanced]
    N --> O{More AI help?}
    O -->|Yes, targeted ask| I
    O -->|No, finish manually| M
    M --> P[Final render via render-worker]
```

---

## 3. Stage Detail

### 3.1 Auth → Dashboard
- On login, land directly on dashboard — no interstitial.
- Center element: chat box, placeholder/greeting `"Ready to kreate, {Username}?"`.
- This is the single entry point for both upload and prompting — not a separate "new project" wizard.

### 3.2 Upload
Accepted at this stage, all optional except video:

| Input | Required | Notes |
|---|---|---|
| Video(s) | Yes, ≥1 | Single long-form (VOD/podcast/stream) **or** multiple clips of mixed length (bloopers, cuts, vlog moments) |
| Music | No | Monet may sync cuts/transitions to it if present |
| Images | No | Available to Monet as overlay/insert material |
| Brief/files | No | Treated as the assignment spec — parsed for constraints, not just vibes |

Long single video handling: Monet segments it into feasible sections on ingest, not as a separate manual step — this happens automatically before directing begins (see 3.4/3.5).

### 3.3 Prompt Resolution
Decision only has two branches — no partial-credit states:

- **Detailed prompt**, or **prompt + (custom or pre-baked) genre selected** → Monet proceeds without Q&A.
- **Vague prompt, no genre** → Monet must ask clarifying questions before ingest/direction begins.

Open decision (flag for build, don't guess): what counts as "detailed enough" — needs an explicit rubric (e.g. presence of tone + audience + length target) or this branch is unenforceable.

### 3.4 Ingest & Frame Analysis
- Python worker extracts frames at a **sample rate chosen per video**, not a fixed constant. Constraint already known from the effects-pipeline work: the vision model (Cloudflare Workers AI, free-tier 10,000 Neuron/day quota) is the hard limiter — a flat 100fps sample on long-form footage will exhaust quota fast.
- Recommended approach: adaptive rate — low fps baseline (~1–2fps) for static/talking-head sections, scene-change-triggered upsampling (burst to higher fps around detected cuts/motion) for action-heavy sections. This gets quality where it matters without flat-rate cost.
- Frames are batched into carousels — multiple frames per vision call, not one call per frame (matches existing "free-prose vision description → separate text-model JSON extraction" pattern already working in the effects pipeline).
- Output of this stage: a per-video timeline of scene/segment boundaries + content descriptions, not raw frames — this is what Monet's director pass consumes next.

### 3.5 Monet's Director Pass
Monet has full write access to a Kove-Advanced project, equivalent to what a human editor would do by hand:
- Cut/trim source clips into the final sequence
- Place/insert user-supplied extra files (images, secondary clips) at chosen points
- Add overlays
- Apply effects and transitions (through the unified `effect-types.ts` / `normalizeEffectType()` system, not raw filter names)
- Add text: content, font, size, and per-instance properties (position, timing, animation) — independently tweakable per text element, not a single global style

Output: an EDL, same shape Kove-Advanced already reads (per the `edlToProject.ts` resolution path) — Monet is not a separate rendering path, it's an EDL author.

### 3.6 Handoff — "Jump to Advanced"
- Explicit, named button. Not automatic, not a mode Monet enters on its own.
- Crossing this boundary hands the same EDL/project state to the user in the full timeline editor — no re-import, no lossy conversion.
- After jumping, user edits are just user edits; Monet's directing job for that session is done unless re-invoked (see 3.7).

### 3.7 Post-Handoff
- User can still request targeted AI help from inside Kove-Advanced (e.g. "add a transition here") without a full re-direct — this should route back into Monet's EDL-authoring path scoped to the user's selection, not a full re-run of 3.4–3.5.
- Open decision: does a targeted ask re-trigger frame analysis, or does Monet work off the already-generated scene/content data from 3.4? Latter is cheaper and should be the default; only re-run 3.4 if the user adds new source material.

### 3.8 Export
- Terminal state reachable directly from Monet's first draft (3.5→export, no forced advanced-editor detour) or after manual edits.
- Executed by the existing render-worker.

---

## 4. Core Data Objects (for the build agent to define concretely)

| Object | Carries |
|---|---|
| `UploadSession` | video(s), music, images, brief files, raw prompt text, genre (custom/pre-baked/none) |
| `PromptResolution` | resolved genre, clarifying Q&A transcript (if any), "ready to direct" flag |
| `SegmentMap` | per-source-video list of scene boundaries + content description, from frame analysis |
| `DirectorEDL` | same schema Kove-Advanced consumes — clips, cuts, overlays, effect instances (typed via `effect-types.ts`), transitions, text elements with independent properties |
| `EditSession` | current EDL + who last touched it (Monet vs user) + handoff state (simple / advanced) |

---

## 5. Decisions (resolved)

1. **Prompt-detail rubric**: skips Q&A only if it specifies (a) tone/vibe, (b) target length/platform, and (c) what to keep vs cut. Missing one → targeted follow-up on just that gap, not a full interview. Genre selection (custom or pre-baked) also skips Q&A regardless.
2. **Adaptive fps**: baseline 1-2fps; burst to 8-12fps for a few seconds around detected scene cuts/high motion. Per-video budget: `min(baseline_frames + burst_frames, daily_quota / expected_concurrent_uploads)`, degrading to baseline-only once a video hits its share.
3. **Post-handoff targeted AI edits reuse `SegmentMap`** — no re-run of frame analysis unless new source material is added in that request.
4. **Handoff is two-way.** "Jump to Advanced" is the common direction, but a "Back to Simple" path also exists — Monet resumes directing from the current EDL state, not from scratch.
5. **Genres**: pre-baked genres live in config; user-created custom genres save to the user's account for reuse across projects.

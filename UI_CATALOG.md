# K.O.V.E. UI Component Catalog

## Layout & Entry Points

| File | Description |
|------|-------------|
| `apps/web/src/main.tsx` | App entry point; mounts React root, wraps in AstryxProvider |
| `apps/web/src/App.tsx` | Top-level router; renders WelcomeScreen, EditorInterface, or MotionCreatorApp based on route |
| `apps/web/src/components/editor/EditorInterface.tsx` | Main editor layout; CSS grid with resizable media/inspector/chat/timeline panels |

## Root Components

| File | Description |
|------|-------------|
| `apps/web/src/components/ErrorBoundary.tsx` | React error boundary with retry UI |
| `apps/web/src/components/Toast.tsx` | Animated toast notification system (success/error/warning/info) |
| `apps/web/src/components/WorkspaceModeTabs.tsx` | Segmented toggle between "Video Editor" and "Motion Design" |
| `apps/web/src/components/MobileBlocker.tsx` | Full-screen overlay blocking mobile devices |

## Welcome / Landing

| File | Description |
|------|-------------|
| `apps/web/src/components/welcome/WelcomeScreen.tsx` | Full welcome/landing page with project creation options |
| `apps/web/src/components/welcome/RecentProjects.tsx` | List of recently auto-saved projects |
| `apps/web/src/components/welcome/TemplateGallery.tsx` | Browsable template gallery with search and category filtering |
| `apps/web/src/components/welcome/TemplateCard.tsx` | Individual template card with preview thumbnail |
| `apps/web/src/components/welcome/TemplatePreviewModal.tsx` | Modal for previewing a template with editable variables |
| `apps/web/src/components/welcome/StartFromScratch.tsx` | Project creation wizard; aspect ratio, resolution, frame rate |
| `apps/web/src/components/welcome/CategoryTabs.tsx` | Horizontal tab bar for filtering templates by category |
| `apps/web/src/components/welcome/WelcomeHero3D.tsx` | Three.js animated 3D hero scene |
| `apps/web/src/components/welcome/RecoveryDialog.tsx` | Modal for recovering unsaved work from auto-save |

## Editor — Top-Level

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/Toolbar.tsx` | Top toolbar with project switcher, undo/redo, export, settings |
| `apps/web/src/components/editor/Preview.tsx` | Main canvas preview (8000+ lines); video/image/text overlays, playback, zoom |
| `apps/web/src/components/editor/AssetsPanel.tsx` | Left sidebar media panel with tabs for media, shapes, text, AI, recipes |
| `apps/web/src/components/editor/InspectorPanel.tsx` | Right sidebar property inspector with tabs for transform, text, effects, etc. |
| `apps/web/src/components/editor/Timeline.tsx` | Main timeline with track lanes, playhead, time ruler |
| `apps/web/src/components/editor/EditorActionRail.tsx` | Left vertical action rail with icon buttons |
| `apps/web/src/components/editor/ExportDialog.tsx` | Export settings dialog with format, resolution, bitrate, codec |
| `apps/web/src/components/editor/CompressDialog.tsx` | Video compression dialog with target size and progress |
| `apps/web/src/components/editor/SearchModal.tsx` | Command palette (Cmd+K) for searching actions, effects, transitions |
| `apps/web/src/components/editor/KeyboardShortcutsOverlay.tsx` | Keyboard shortcuts reference dialog |
| `apps/web/src/components/editor/KeyframeEditorPanel.tsx` | Side panel for editing keyframe properties |
| `apps/web/src/components/editor/ProjectSwitcher.tsx` | Project switcher dropdown |
| `apps/web/src/components/editor/ProcessingOverlay.tsx` | Overlay showing background processing tasks |
| `apps/web/src/components/editor/ScreenRecorder.tsx` | Screen recording setup dialog |
| `apps/web/src/components/editor/RecordingControls.tsx` | Floating controls during screen recording |
| `apps/web/src/components/editor/RecordingCountdown.tsx` | Full-screen 3-2-1 countdown before recording |
| `apps/web/src/components/editor/SaveTemplateDialog.tsx` | Dialog for saving project as reusable template |
| `apps/web/src/components/editor/ScriptViewDialog.tsx` | JSON/script viewer for inspecting EDL/creation state |
| `apps/web/src/components/editor/AIGenTab.tsx` | AI generation tab in assets panel |

## Editor — Chat (Monet AI Director)

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/chat/ChatPanel.tsx` | AI chat panel; message history, composer, model picker, history sidebar |
| `apps/web/src/components/editor/chat/ChatMessage.tsx` | Single chat message bubble with user/bot avatar |
| `apps/web/src/components/editor/chat/ChatComposer.tsx` | Text input area with send/stop buttons |
| `apps/web/src/components/editor/chat/ChatHistoryPanel.tsx` | Sidebar listing past chat sessions |
| `apps/web/src/components/editor/chat/MarkdownMessage.tsx` | Markdown renderer for chat messages |
| `apps/web/src/components/editor/chat/InlineConfirmCard.tsx` | Inline card for AI tool calls requiring confirmation |
| `apps/web/src/components/editor/chat/ChatErrorCard.tsx` | Error display card with categorized actions |
| `apps/web/src/components/editor/chat/ToolCallCard.tsx` | Expandable card showing AI tool call execution status |
| `apps/web/src/components/editor/chat/ProviderModelPicker.tsx` | LLM provider and model selector dropdown |

## Editor — Panels

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/panels/AutoEditPanel.tsx` | Beat-synced auto-edit panel |
| `apps/web/src/components/editor/panels/EffectsTransitionsPanel.tsx` | Browser for video effects and transitions |
| `apps/web/src/components/editor/panels/HighlightExtractorPanel.tsx` | AI-powered highlight extraction panel |
| `apps/web/src/components/editor/panels/TemplatesTab.tsx` | Template browser tab in assets panel |
| `apps/web/src/components/editor/panels/EditingTemplateControls.tsx` | Dynamic controls for editing template variables |
| `apps/web/src/components/editor/panels/CreationReviewPanel.tsx` | Motion composition review panel |
| `apps/web/src/components/editor/panels/RecipesTab.tsx` | Pre-built editing recipe browser |

## Editor — Inspector (47 components)

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/inspector/TextSection.tsx` | Text property inspector (font, size, color, alignment) |
| `apps/web/src/components/editor/inspector/VideoEffectsSection.tsx` | Video effects inspector |
| `apps/web/src/components/editor/inspector/AudioEffectsSection.tsx` | Audio effects inspector (EQ, compression, reverb) |
| `apps/web/src/components/editor/inspector/SpeedSection.tsx` | Speed/duration controls |
| `apps/web/src/components/editor/inspector/SpeedRampSection.tsx` | Speed ramp editor |
| `apps/web/src/components/editor/inspector/CropSection.tsx` | Crop controls |
| `apps/web/src/components/editor/inspector/ColorGradingSection.tsx` | Color grading controls |
| `apps/web/src/components/editor/inspector/HSLControls.tsx` | HSL color wheel controls |
| `apps/web/src/components/editor/inspector/ColorWheelsControl.tsx` | Three-way color wheels |
| `apps/web/src/components/editor/inspector/CurvesEditor.tsx` | Bezier curves editor |
| `apps/web/src/components/editor/inspector/FilterPresetsPanel.tsx` | LUT and filter preset browser |
| `apps/web/src/components/editor/inspector/LUTLoader.tsx` | LUT file loader |
| `apps/web/src/components/editor/inspector/ScopesPanel.tsx` | Video scopes (waveform, vectorscope, histogram) |
| `apps/web/src/components/editor/inspector/BlendingSection.tsx` | Blend mode and opacity controls |
| `apps/web/src/components/editor/inspector/MaskSection.tsx` | Mask creation and editing controls |
| `apps/web/src/components/editor/inspector/KeyframesSection.tsx` | Keyframe list and management |
| `apps/web/src/components/editor/inspector/AlignmentSection.tsx` | Alignment and snap controls |
| `apps/web/src/components/editor/inspector/TransitionInspector.tsx` | Transition parameter inspector |
| `apps/web/src/components/editor/inspector/ClipTransitionSection.tsx` | Per-clip transition controls |
| `apps/web/src/components/editor/inspector/ShapeSection.tsx` | Shape properties (fill, stroke, radius) |
| `apps/web/src/components/editor/inspector/SVGSection.tsx` | SVG element property inspector |
| `apps/web/src/components/editor/inspector/PhotoLayersSection.tsx` | Photo/image layer compositing |
| `apps/web/src/components/editor/inspector/PiPSection.tsx` | Picture-in-picture overlay controls |
| `apps/web/src/components/editor/inspector/TextAnimationSection.tsx` | Text animation style and timing |
| `apps/web/src/components/editor/inspector/EmphasisAnimationSection.tsx` | Emphasis animation controls |
| `apps/web/src/components/editor/inspector/MotionPathSection.tsx` | Motion path configuration |
| `apps/web/src/components/editor/inspector/MotionPresetsPanel.tsx` | Pre-built motion preset browser |
| `apps/web/src/components/editor/inspector/MotionTrackingSection.tsx` | Motion tracking configuration |
| `apps/web/src/components/editor/inspector/BehindSubjectSection.tsx` | Behind-subject layering effects |
| `apps/web/src/components/editor/inspector/GreenScreenSection.tsx` | Chroma key / green screen removal |
| `apps/web/src/components/editor/inspector/BackgroundRemovalSection.tsx` | AI background removal |
| `apps/web/src/components/editor/inspector/StabilizationSection.tsx` | Video stabilization settings |
| `apps/web/src/components/editor/inspector/NoiseReductionSection.tsx` | Audio noise reduction |
| `apps/web/src/components/editor/inspector/AudioDuckingSection.tsx` | Audio ducking controls |
| `apps/web/src/components/editor/inspector/AutoCutSilenceSection.tsx` | Auto silence detection and removal |
| `apps/web/src/components/editor/inspector/AutoReframeSection.tsx` | Auto-reframe for different aspect ratios |
| `apps/web/src/components/editor/inspector/BeatSyncSection.tsx` | Beat sync controls |
| `apps/web/src/components/editor/inspector/ParticleEffectsSection.tsx` | Particle effects configuration |
| `apps/web/src/components/editor/inspector/RetouchingSection.tsx` | Face/body retouching controls |
| `apps/web/src/components/editor/inspector/AdjustmentLayerSection.tsx` | Adjustment layer property controls |
| `apps/web/src/components/editor/inspector/NestedSequenceSection.tsx` | Nested sequence / compound clip controls |
| `apps/web/src/components/editor/inspector/TextToSpeechPanel.tsx` | TTS generation panel |
| `apps/web/src/components/editor/inspector/VoiceBrowser.tsx` | TTS voice selection browser |
| `apps/web/src/components/editor/inspector/AudioResult.tsx` | Audio generation result display |
| `apps/web/src/components/editor/inspector/AudioTextSyncPanel.tsx` | Audio-text synchronization |
| `apps/web/src/components/editor/inspector/MusicLibraryPanel.tsx` | Music library browser |
| `apps/web/src/components/editor/inspector/StickerPickerPanel.tsx` | Sticker/emoji picker panel |
| `apps/web/src/components/editor/inspector/StickerPicker.tsx` | Sticker grid selection |
| `apps/web/src/components/editor/inspector/CaptionEditorPanel.tsx` | Caption/subtitle editor |
| `apps/web/src/components/editor/inspector/AutoCaptionPanel.tsx` | Auto-caption generation panel |
| `apps/web/src/components/editor/inspector/EnhancedTextPreview.tsx` | Rich text preview with real-time rendering |
| `apps/web/src/components/editor/inspector/TemplateVariablesPanel.tsx` | Template variable editor |
| `apps/web/src/components/editor/inspector/TemplatesBrowserPanel.tsx` | Template browser in inspector |
| `apps/web/src/components/editor/inspector/MultiClipInspector.tsx` | Inspector for multiple selected clips |
| `apps/web/src/components/editor/inspector/HistoryPanel.tsx` | Undo/redo history panel |
| `apps/web/src/components/editor/inspector/MarkersPanel.tsx` | Timeline markers list |
| `apps/web/src/components/editor/inspector/SceneNavigatorPanel.tsx` | Scene-by-scene navigation |
| `apps/web/src/components/editor/inspector/ShaderControls.tsx` | Motion shader parameter controls |
| `apps/web/src/components/editor/inspector/ModelSelector.tsx` | AI model selector |
| `apps/web/src/components/editor/inspector/MultiCameraPanel.tsx` | Multi-camera angle switching |
| `apps/web/src/components/editor/inspector/SVGImporter.tsx` | SVG file import panel |

## Editor — Preview Overlays

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/preview/CropModeView.tsx` | Interactive crop overlay with drag handles |
| `apps/web/src/components/editor/preview/MotionPathOverlay.tsx` | SVG overlay for motion path bezier curves |
| `apps/web/src/components/editor/preview/MotionPathHandles.tsx` | Draggable handle points for motion paths |
| `apps/web/src/components/editor/preview/ParticleRenderer.tsx` | Three.js particle effect renderer |

## Editor — Timeline (17 components)

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/timeline/ClipComponent.tsx` | Main video/audio clip rendering with drag, resize, waveforms |
| `apps/web/src/components/editor/timeline/TextClipComponent.tsx` | Text clip rendering with drag and resize |
| `apps/web/src/components/editor/timeline/ShapeClipComponent.tsx` | Shape/SVG/sticker clip rendering |
| `apps/web/src/components/editor/timeline/TrackHeader.tsx` | Track header with name, visibility, mute/solo, lock |
| `apps/web/src/components/editor/timeline/TrackLane.tsx` | Container for a single track's clips |
| `apps/web/src/components/editor/timeline/Playhead.tsx` | Vertical playhead line with triangle indicator |
| `apps/web/src/components/editor/timeline/TimeRuler.tsx` | Time ruler with tick marks and beat markers |
| `apps/web/src/components/editor/timeline/TransitionHandle.tsx` | Draggable handle between adjacent clips |
| `apps/web/src/components/editor/timeline/KeyframeTrack.tsx` | Keyframe track with diamond markers |
| `apps/web/src/components/editor/timeline/KeyframeMarker.tsx` | Individual keyframe diamond marker |
| `apps/web/src/components/editor/timeline/EasingCurve.tsx` | SVG easing curve visualization |
| `apps/web/src/components/editor/timeline/MarkerIndicator.tsx` | Colored flag marker on timeline |
| `apps/web/src/components/editor/timeline/BeatMarkerOverlay.tsx` | Overlay showing beat positions |
| `apps/web/src/components/editor/timeline/AdjustmentLayerTimelineItem.tsx` | Adjustment layer in timeline |
| `apps/web/src/components/editor/timeline/CaptionBatchSelectButton.tsx` | Batch-select all caption clips |
| `apps/web/src/components/editor/timeline/ClipContextMenu.tsx` | Right-click menu for video/audio clips |
| `apps/web/src/components/editor/timeline/GraphicsClipContextMenu.tsx` | Right-click menu for text/shape clips |

## Editor — Settings

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/settings/SettingsDialog.tsx` | Main settings dialog with tabs |
| `apps/web/src/components/editor/settings/GeneralPanel.tsx` | General settings: theme, autosave, defaults |
| `apps/web/src/components/editor/settings/ApiKeysPanel.tsx` | API key management |
| `apps/web/src/components/editor/settings/McpPanel.tsx` | MCP server settings |
| `apps/web/src/components/editor/settings/MasterPasswordDialog.tsx` | Master encryption password dialog |

## Editor — AI Image Generation (KieAI)

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/kieai/KieAIImageDialog.tsx` | AI image generation dialog |
| `apps/web/src/components/editor/kieai/ModelPicker.tsx` | Image model selector |
| `apps/web/src/components/editor/kieai/forms/SeedreamForm.tsx` | Seedream generation form |
| `apps/web/src/components/editor/kieai/forms/Flux2Form.tsx` | Flux2 generation form |
| `apps/web/src/components/editor/kieai/forms/GrokForm.tsx` | Grok generation form |
| `apps/web/src/components/editor/kieai/forms/QwenForm.tsx` | Qwen generation form |
| `apps/web/src/components/editor/kieai/forms/NanoBanana2Form.tsx` | NanoBanana2 generation form |
| `apps/web/src/components/editor/kieai/forms/ZImageForm.tsx` | ZImage generation form |

## Editor — Tour / Onboarding

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/tour/SpotlightTour.tsx` | First-time onboarding spotlight tour |
| `apps/web/src/components/editor/tour/MoGraphTour.tsx` | Motion graphics feature tour |
| `apps/web/src/components/editor/tour/TourPopover.tsx` | Popover tooltip for tours |

## Editor — Misc

| File | Description |
|------|-------------|
| `apps/web/src/components/editor/dialogs/AspectRatioMatchDialog.tsx` | Dialog to match project aspect ratio to video |
| `apps/web/src/components/audio-mixer/AudioMixer.tsx` | Master audio mixer with per-track channel strips |
| `apps/web/src/components/audio-mixer/ChannelStrip.tsx` | Individual track mixer strip |
| `apps/web/src/components/shaders/ShaderPreviewBrowser.tsx` | Grid browser of motion shader presets |
| `apps/web/src/components/astryx/AstryxProvider.tsx` | Theme provider wrapper |

## Shared UI Library (`packages/ui/src/components/`)

### Radix Primitives (23)

| File | Description |
|------|-------------|
| `alert.tsx` | Alert with title and description |
| `button.tsx` | Base button with variants and sizes |
| `card.tsx` | Card layout with header, content, footer |
| `checkbox.tsx` | Checkbox input |
| `collapsible.tsx` | Collapsible/accordion primitive |
| `context-menu.tsx` | Right-click context menu |
| `dialog.tsx` | Modal dialog with overlay |
| `dropdown-menu.tsx` | Dropdown menu with sub-menus |
| `icon-button.tsx` | Icon-only button |
| `input.tsx` | Text input field |
| `label.tsx` | Form label |
| `labeled-slider.tsx` | Slider with label |
| `popover.tsx` | Popover/floating panel |
| `progress.tsx` | Progress bar |
| `scroll-area.tsx` | Custom scrollbar container |
| `select.tsx` | Select dropdown |
| `skeleton.tsx` | Loading skeleton |
| `slider.tsx` | Range slider |
| `switch.tsx` | Toggle switch |
| `tabs.tsx` | Tab navigation |
| `toggle.tsx` | Toggle button |
| `toggle-group.tsx` | Group of toggle buttons |
| `tooltip.tsx` | Tooltip |

### Toolcraft Branded (28)

| File | Description |
|------|-------------|
| `toolcraft-button.tsx` | Branded button with icon, loading, label |
| `toolcraft-text.tsx` | Typography component |
| `toolcraft-heading.tsx` | Heading component (h1-h6) |
| `toolcraft-badge.tsx` | Badge/tag with variants |
| `toolcraft-card.tsx` | Branded card container |
| `toolcraft-clickable-card.tsx` | Clickable card with hover states |
| `toolcraft-selectable-card.tsx` | Card with selected state |
| `toolcraft-dialog-layout.tsx` | Standardized dialog layout |
| `toolcraft-icon-button.tsx` | Branded icon button with tooltip |
| `toolcraft-tooltip.tsx` | Tooltip with positioning |
| `toolcraft-popover.tsx` | Positioned popover |
| `toolcraft-spinner.tsx` | Loading spinner |
| `toolcraft-progress-bar.tsx` | Labeled progress bar |
| `toolcraft-segmented-control.tsx` | Segmented toggle control |
| `toolcraft-panel-section.tsx` | Collapsible panel section |
| `toolcraft-collapsible.tsx` | Branded collapsible |
| `toolcraft-kbd.tsx` | Keyboard shortcut chip |
| `toolcraft-link.tsx` | Styled link |
| `toolcraft-empty-state.tsx` | Empty state placeholder |
| `toolcraft-slider.tsx` | Branded slider |
| `toolcraft-slider-control.tsx` | Slider with label and value |
| `toolcraft-input-control.tsx` | Form control wrappers |
| `toolcraft-number-field-group.tsx` | Grouped number inputs |
| `toolcraft-switch-control.tsx` | Labeled toggle switch |
| `toolcraft-checkbox-input.tsx` | Branded checkbox |
| `toolcraft-file-drop-control.tsx` | Drag-and-drop file upload |
| `toolcraft-menu.tsx` | Branded context/dropdown menu |
| `color-picker.tsx` | Color picker with hex/rgb |

## Summary

| Location | Count |
|----------|-------|
| `apps/web/src/components/` (root + welcome + audio + shaders + astryx) | 16 |
| `apps/web/src/components/editor/` (top-level) | 19 |
| `apps/web/src/components/editor/chat/` | 9 |
| `apps/web/src/components/editor/panels/` | 7 |
| `apps/web/src/components/editor/inspector/` | 51 |
| `apps/web/src/components/editor/preview/` | 4 |
| `apps/web/src/components/editor/timeline/` | 17 |
| `apps/web/src/components/editor/settings/` | 5 |
| `apps/web/src/components/editor/kieai/` | 8 |
| `apps/web/src/components/editor/tour/` | 3 |
| `apps/web/src/components/editor/dialogs/` | 1 |
| **apps/web total** | **140** |
| `packages/ui/` (Radix + Toolcraft) | 51 |
| **Grand total** | **191** |

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./index.css";
// Monet design system — imported after index.css so its (unlayered)
// custom-property definitions supersede the legacy token block.
import "./styles/tokens.css";
import "./styles/glass.css";
import { AstryxProvider } from "./components/astryx/AstryxProvider";
import { registerServiceWorker } from "./services/service-worker";
import { initCustomFonts } from "./components/editor/inspector/font-options";
import { setEncoderBackendFactory } from "@kove-advanced/core";
import { NativeFFmpegBackend } from "./services/native-ffmpeg-backend";
import { getLiveEditorHost } from "./services/agent/host-singleton";
import { createExportJobRunner } from "./services/agent/export-job-runner";

const DesktopApp = React.lazy(() =>
  import("./desktop/DesktopApp").then((module) => ({
    default: module.DesktopApp,
  })),
);

const isDesktop =
  typeof window !== "undefined" && (window as unknown as Record<string, unknown>)["kove-advanced"] != null;

if (isDesktop) {
  setEncoderBackendFactory(
    () =>
      new NativeFFmpegBackend(
        () =>
          (window as unknown as Record<string, string | undefined>).__kove_advancedExportPath ??
          "",
      ),
  );
} else {
  getLiveEditorHost().setJobRunner(createExportJobRunner());
}

registerServiceWorker().then((registration) => {
  if (registration) {
  }
});

void initCustomFonts();

const root = document.getElementById("root")!;

async function renderApplication(): Promise<void> {
  const application: React.ReactNode = isDesktop ? (
        <React.Suspense fallback={<div className="h-screen w-screen bg-bg" />}>
          <DesktopApp />
        </React.Suspense>
      ) : (
        <App />
      );

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AstryxProvider>{application}</AstryxProvider>
    </React.StrictMode>,
  );
}

void renderApplication();

// Reference measurement runs OpenCV.js in a worker; its Emscripten eval takes
// longer than any measurement head start, so warm it once the app is idle.
const warmMotionWorker = () => {
  void import("./services/mirror/opencv-motion-client").then((module) => module.warmOpenCvMotionWorker());
};
if (typeof requestIdleCallback === "function") requestIdleCallback(() => warmMotionWorker(), { timeout: 10_000 });
else setTimeout(warmMotionWorker, 4_000);

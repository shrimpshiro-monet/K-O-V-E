import { frameRate, frameToSeconds, shotDurationFrames } from "@kove-advanced/core/mirror/timebase";
import type { ReferenceClock } from "../../services/mirror/extract-reference";
import { useState } from "react";
import { ToolcraftButton as Button } from "@kove-advanced/ui";
import { executeTool } from "@kove-advanced/agent";
import { allocateSourceRanges } from "@kove-advanced/core/mirror/allocate-shots";
import { serializeReferenceProfile, type ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { LabStats } from "@kove-advanced/core/color/reinhard-transfer";
import { useProjectStore } from "../../stores/project-store";
import { toast } from "../../stores/notification-store";
import { getLiveEditorHost, runExclusive } from "../../services/agent/host-singleton";
import { extractReference, probeReferenceClock, sampleVideoStats } from "../../services/mirror/extract-reference";
import { enrichReferenceWithAudio } from "../../services/mirror/enrich-reference-audio";

export function MirrorReferencePanel() {
  const media = useProjectStore((s) => s.project.mediaLibrary.items.filter((m) => m.type === "video"));
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fpsNum, setFpsNum] = useState("");
  const [fpsDen, setFpsDen] = useState("");
  const [shotIds, setShotIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [profile, setProfile] = useState<ReferenceProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const extract = async (file: File, clock: ReferenceClock) => {
    setBusy(true); setStatus("Measuring shots, motion and color on this device…");
    try {
      const measured = await extractReference(file, clock, {
        onProgress: (done, total) => setStatus(`Measuring shots… ${done}/${total} frames`),
      });
      getLiveEditorHost().setMirrorReference(file);
      setStatus(`${measured.shots.length} shots measured. Detecting beats and transcribing captions locally…`);
      let next = measured;
      try {
        next = await enrichReferenceWithAudio(file, measured, { onStatus: setStatus });
      } catch {
        next = { ...measured, warnings: [...(measured.warnings ?? []), "Audio annotation enrichment failed; the measured profile is used as-is."] };
      }
      setPendingFile(null);
      setProfile(next); setReferenceFile(file); setShotIds([]);
      try { sessionStorage.setItem("kove.mirror.profile", serializeReferenceProfile(next)); } catch { /* download still works in privacy mode */ }
      const captionCount = next.shots.reduce((sum, shot) => sum + shot.captionWindows.length, 0);
      const beatsPart = next.beatGridMs.length > 0 ? `${next.beatGridMs.length} beats` : "no beats";
      const captionsPart = captionCount > 0 ? `${captionCount} caption windows` : "no captions";
      setStatus(`${next.shots.length} shots measured · ${captionsPart} · ${beatsPart}.${next.warnings?.length ? ` ${next.warnings.join(" ")}` : ""}`);
    } catch (error) { toast.error("Reference extraction failed", error instanceof Error ? error.message : "Unknown error"); }
    finally { setBusy(false); }
  };
  const chooseFile = async (file?: File) => {
    if (!file) return;
    getLiveEditorHost().setMirrorReference(null);
    setFpsNum(""); setFpsDen("");
    setReferenceFile(null); setProfile(null); setPendingFile(null); setShotIds([]);
    setBusy(true);
    try {
      const result = await probeReferenceClock(file);
      if (result.status === "known") { setBusy(false); await extract(file, result.clock); }
      else { setPendingFile(file); setStatus(`FPS unknown: ${result.reason}`); }
    } catch (error) { toast.error("Reference probe failed", error instanceof Error ? error.message : "Unknown error"); }
    finally { setBusy(false); }
  };
  const confirmFps = () => {
    if (!pendingFile) return;
    try { void extract(pendingFile, { fps: frameRate(Number(fpsNum), Number(fpsDen)), fpsSource: "user" }); }
    catch (error) { toast.error("Invalid FPS", error instanceof Error ? error.message : "Use positive integer numerator and denominator"); }
  };
  const apply = async () => {
    if (!profile || !selected.length) return;
    setBusy(true); setStatus("Compiling editable timeline…");
    try {
      const stats: LabStats[] = [];
      const ranges = allocateSourceRanges(profile.shots.map((shot) => frameToSeconds(shotDurationFrames(shot), profile.fps)), selected.map((id) => {
        const item = media.find((m) => m.id === id);
        if (!item) throw new Error(`Source video not found: ${id}`);
        return { id, duration: item.metadata.duration };
      }));
      const statsByRange = new Map<string, LabStats>();
      for (let i = 0; i < profile.shots.length; i++) {
        const range = ranges[i];
        const item = media.find((m) => m.id === range.mediaId);
        const blob = item?.blob ?? await item?.fileHandle?.getFile();
        if (!blob) throw new Error(`Source video ${item?.name ?? "unknown"} is not available locally`);
        const key = `${range.mediaId}:${range.inPoint}`;
        const measured = statsByRange.get(key) ?? await sampleVideoStats(blob, range.inPoint + Math.min(0.25, (range.outPoint - range.inPoint) / 2));
        statsByRange.set(key, measured);
        stats.push(measured);
      }
      const result = await runExclusive(() => executeTool("mirror_reference_1to1", { profile, userMediaIds: selected, targetStats: stats }, getLiveEditorHost()));
      if (!result.ok) throw new Error(result.error?.message ?? result.summary);
      const data = result.data as { shotItemIds: string[] };
      setShotIds(data.shotItemIds);
      setStatus(result.summary);
      toast.success("Mirror compiled", result.summary);
    } catch (error) { toast.error("Mirror failed", error instanceof Error ? error.message : "Unknown error"); }
    finally { setBusy(false); }
  };
  const refine = async () => {
    if (!profile || !referenceFile || !shotIds.length) return;
    setBusy(true); setStatus("Rendering reference and timeline frames; measuring SSIM…");
    try {
      getLiveEditorHost().setMirrorReference(referenceFile);
      const result = await runExclusive(() => executeTool("mirror_refine", { shotItemIds: shotIds, iterations: 6 }, getLiveEditorHost()));
      if (!result.ok) throw new Error(result.error?.message ?? result.summary);
      setStatus(result.summary);
    } catch (error) { toast.error("Render-backed refinement unavailable", error instanceof Error ? error.message : "Unknown error"); }
    finally { setBusy(false); }
  };
  const download = () => {
    if (!profile) return;
    const url = URL.createObjectURL(new Blob([serializeReferenceProfile(profile)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "kove-editdna.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="space-y-3 text-xs">
    <p>Choose a reference video to measure locally. Select imported source videos for the editable mirror. The original reference is never inserted.</p>
    <label className="block">Reference video <input aria-label="Reference video" type="file" accept="video/*" disabled={busy} onChange={(e) => { void chooseFile(e.target.files?.[0]); }} /></label>
    {pendingFile && <div role="group" aria-label="Select reference FPS" className="space-y-2">
      <p>FPS unknown. Choose the reference frame clock explicitly (e.g. 30000 / 1001 or 24 / 1). This is a user-selected conform, not measured source FPS.</p>
      <label>Numerator <input aria-label="FPS numerator" type="number" min="1" placeholder="30000" value={fpsNum} onChange={(e) => setFpsNum(e.target.value)} /></label>
      <label>Denominator <input aria-label="FPS denominator" type="number" min="1" placeholder="1001" value={fpsDen} onChange={(e) => setFpsDen(e.target.value)} /></label>
      <Button label="Analyze using selected FPS" disabled={busy || !fpsNum || !fpsDen} onClick={confirmFps} />
    </div>}
    {profile && <>
      <p>{profile.shots.length} shots · {profile.aspectRatio.width}×{profile.aspectRatio.height} · {profile.fps.num}/{profile.fps.den} fps ({profile.fpsSource}) output timebase</p>
      <div className="space-y-1">Your footage (in selection order):
        {media.map((m) => <label className="flex gap-2" key={m.id}><input type="checkbox" checked={selected.includes(m.id)} disabled={busy} onChange={() => setSelected((current) => current.includes(m.id) ? current.filter((id) => id !== m.id) : [...current, m.id])} />{m.name}</label>)}
      </div>
      {shotIds.length > 0 && <Button label={busy ? "Rendering…" : "Refine from proxy renders"} disabled={busy} onClick={() => { void refine(); }} />}
      <Button label="Download EditDNA JSON" onClick={download} variant="ghost" />
      <Button label={busy ? "Working…" : "Mirror Reference 1:1"} onClick={() => { void apply(); }} disabled={busy || !selected.length} />
    </>}
    {status && <p role="status">{status}</p>}
    <p className="text-text-muted">Grayscale SSIM is measured from decoded/rendered proxies, not semantic parity. LPIPS requires a real model backend. Captions and beats are extracted locally when the reference has audio.</p>
  </div>;
}

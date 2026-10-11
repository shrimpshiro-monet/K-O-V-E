import { useCallback, useEffect, useState, type JSX, type KeyboardEvent } from "react";
import { ArrowRight, X } from "@/icons/lucide-compat";
import {
  ToolcraftButton as Button,
  ToolcraftFileDropControl,
  ToolcraftTextAreaControl,
  ToolcraftText as Text,
} from "@kove-advanced/ui";
import { useChatStore } from "../../stores/chat-store";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { useRouter } from "../../hooks/use-router";

const ACCEPT = "video/*,audio/*,image/*";

const fileKey = (file: File): string => `${file.name}:${file.size}:${file.lastModified}`;

/**
 * Chat-first entry surface (spec flow stage 1-3): the greeting box is the
 * single entry point — no new-project wizard. The user adds at least one
 * video (music/images optional) plus a brief, and Kreate imports everything
 * into the open project, hands the brief to the same `send()` path a typed
 * chat message uses (so the director workflow runs exactly as before), and
 * drops the user into the editor while Monet drafts.
 */
export function KreateEntry(): JSX.Element {
  const { navigate } = useRouter();
  const skipWelcomeScreen = useUIStore((state) => state.skipWelcomeScreen);
  const [files, setFiles] = useState<File[]>([]);
  const [brief, setBrief] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (skipWelcomeScreen) navigate("editor");
  }, [skipWelcomeScreen, navigate]);

  const hasVideo = files.some((file) => file.type.startsWith("video/"));
  const canKreate = !starting && hasVideo && brief.trim().length > 0;

  const handleFiles = useCallback((incoming: File[]) => {
    setFiles((previous) => {
      const seen = new Set(previous.map(fileKey));
      return [...previous, ...incoming.filter((file) => !seen.has(fileKey(file)))];
    });
    setError(null);
  }, []);

  const removeFile = useCallback((key: string) => {
    setFiles((previous) => previous.filter((file) => fileKey(file) !== key));
  }, []);

  const kreate = useCallback(async () => {
    if (!canKreate) return;
    setStarting(true);
    setError(null);
    try {
      const projectState = useProjectStore.getState();
      if (!projectState.hasOpenProject) projectState.createNewProject();
      for (const file of files) {
        const result = await useProjectStore.getState().importMedia(file);
        if (!result.success) {
          setError(result.error?.message ?? `Could not import ${file.name}.`);
          return;
        }
      }
      navigate("editor");
      void useChatStore.getState().send(brief.trim());
    } finally {
      setStarting(false);
    }
  }, [canKreate, files, brief, navigate]);

  const onBriefKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void kreate();
      }
    },
    [kreate],
  );

  const hint = !hasVideo
    ? "Add at least one video to continue."
    : !brief.trim()
      ? "Describe the edit you want."
      : "Monet will draft the edit — you can refine it in chat or jump into the timeline.";

  return (
    <div className="relative h-full w-full overflow-y-auto bg-background">
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="w-full max-w-2xl">
          <div className="mb-10 text-center">
            <Text
              type="body"
              weight="bold"
              className="mb-3 text-4xl tracking-tight text-text-primary"
            >
              Ready to kreate?
            </Text>
            <Text type="supporting" color="secondary" className="text-lg text-text-secondary">
              Add your footage, tell me what you want — I&apos;ll direct the edit.
            </Text>
          </div>

          <ToolcraftFileDropControl
            label="Add footage"
            description="At least one video. Music and images are optional."
            accept={ACCEPT}
            multiple
            onFilesSelect={handleFiles}
            className="mb-3"
          />

          {files.length > 0 && (
            <ul className="mb-4 flex flex-wrap gap-2" aria-label="Selected files">
              {files.map((file) => (
                <li
                  key={fileKey(file)}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg"
                >
                  <span className="max-w-48 truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeFile(fileKey(file))}
                    className="grid h-4 w-4 place-items-center rounded text-fg-muted transition-colors hover:text-status-error"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-lg border border-border bg-bg-2 transition-colors focus-within:border-accent">
            <ToolcraftTextAreaControl
              label="What should this edit be?"
              isLabelHidden
              value={brief}
              onChange={setBrief}
              onKeyDown={onBriefKeyDown}
              rows={3}
              placeholder="A 60-second hype reel from my stream clips — punchy, fast cuts, bold captions…"
              inputClassName="block w-full resize-none bg-transparent px-3 py-2 text-[13px] text-fg outline-none placeholder:text-fg-muted"
            />
          </div>

          <div className="mt-4 flex flex-col items-center gap-2">
            <Button
              label="Kreate"
              variant="primary"
              icon={<ArrowRight size={16} aria-hidden />}
              isLoading={starting}
              disabled={!canKreate}
              onClick={() => void kreate()}
              className="rounded-xl px-6"
            />
            <Text type="supporting" color="secondary" className="text-xs text-text-muted">
              {hint}
            </Text>
            {error && (
              <Text
                type="supporting"
                className="text-xs text-status-error"
                role="alert"
              >
                {error}
              </Text>
            )}
          </div>

          <div className="mt-8 text-center">
            <Button
              label="Open the editor instead"
              variant="ghost"
              onClick={() => navigate("editor")}
              className="rounded-xl"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default KreateEntry;

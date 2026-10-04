import React, { useCallback } from "react";
import { motion } from "framer-motion";
import {
  ToolcraftDropdownMenu as DropdownMenu,
  ToolcraftTooltip as Tooltip,
} from "@kove-advanced/ui";
import { Icon } from "@/icons/Icon";
import {
  House,
  Sun,
  Moon,
  SunMoon,
  Settings,
  Circle,
  Play,
  Sparkles,
  HelpCircle,
  FileCode,
  Command,
} from "@/icons/lucide-compat";
import { useUIStore } from "../../stores/ui-store";
import { useProjectStore } from "../../stores/project-store";
import { useThemeStore } from "../../stores/theme-store";
import { useSettingsStore } from "../../stores/settings-store";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useRouter } from "../../hooks/use-router";
import {
  startTour,
  ONBOARDING_KEY,
  startMoGraphTour,
  MOGRAPH_TOUR_KEY,
} from "./tour";

interface RailButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

/**
 * 56px icon rail — grouped tools with a sliding accent indicator.
 * Undo/Redo no longer live here (they moved to the top bar as global
 * actions). The indicator uses a shared layoutId so it glides between
 * items; reduced-motion users get an instant jump instead.
 */
const RailButton: React.FC<RailButtonProps> = ({
  label,
  icon,
  onClick,
  active = false,
  disabled = false,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <Tooltip content={label} placement="end">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={`relative grid h-10 w-10 place-items-center rounded-[10px] transition-colors duration-fast ${
          active
            ? "text-accent"
            : "text-fg-muted hover:bg-hover hover:text-fg"
        } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
      >
        {active &&
          (reducedMotion ? (
            <span
              aria-hidden
              className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent"
              style={{ boxShadow: "0 0 8px var(--accent-primary-glow)" }}
            />
          ) : (
            <motion.span
              layoutId="rail-active-indicator"
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
              className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent"
              style={{ boxShadow: "0 0 8px var(--accent-primary-glow)" }}
            />
          ))}
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-0 rounded-[10px] transition-opacity duration-base ${
            active ? "opacity-100" : "opacity-0"
          }`}
          style={{
            background:
              "radial-gradient(60% 60% at 50% 50%, var(--accent-soft), transparent 70%)",
          }}
        />
        <span className="relative">{icon}</span>
      </button>
    </Tooltip>
  );
};

const RailDivider: React.FC = () => (
  <div className="my-1.5 h-px w-6 bg-line" aria-hidden />
);

export const EditorActionRail: React.FC = () => {
  const { createMotionComposition } = useProjectStore();
  const {
    openModal,
    toggleKeyframeEditor,
    keyframeEditorOpen,
    panels,
    togglePanel,
    activeModal,
  } = useUIStore();
  const { mode: themeMode, toggleTheme } = useThemeStore();
  const { openSettings } = useSettingsStore();
  const { navigate } = useRouter();

  const themeLabel =
    themeMode === "auto"
      ? "System"
      : themeMode.charAt(0).toUpperCase() + themeMode.slice(1);
  const nextThemeLabel =
    themeMode === "light" ? "Dark" : themeMode === "dark" ? "System" : "Light";
  const themeIcon =
    themeMode === "light" ? (
      <Sun size={16} aria-hidden />
    ) : themeMode === "dark" ? (
      <Moon size={16} aria-hidden />
    ) : (
      <SunMoon size={16} aria-hidden />
    );
  const themeActionLabel = `Theme: ${themeLabel}. Switch to ${nextThemeLabel}`;

  const handleCreateMotionScene = useCallback(async () => {
    const composition = await createMotionComposition("Motion Scene");
    if (composition) {
      navigate("motion", { compositionId: composition.id });
    }
  }, [createMotionComposition, navigate]);

  return (
    <nav
      data-tour="toolbar"
      aria-label="Editor tools"
      className="glass-panel flex w-14 shrink-0 flex-col items-center gap-1 rounded-2xl py-3"
    >
      {/* ── Command palette trigger ───────────────────────────── */}
      <Tooltip content="Search & commands  ⌘K" placement="end">
        <button
          type="button"
          aria-label="Search tools, effects, or ask AI (⌘K)"
          onClick={() => openModal("search")}
          className="grid h-9 w-9 place-items-center rounded-[10px] border border-line bg-bg-2/70 text-fg-muted transition-colors duration-fast hover:border-accent hover:text-accent"
        >
          <span className="flex items-center gap-0.5 text-[10px] font-semibold">
            <Command size={11} aria-hidden />K
          </span>
        </button>
      </Tooltip>

      <RailDivider />

      {/* ── Group A — Navigation ──────────────────────────────── */}
      <Tooltip content="Back to home" placement="end">
        <button
          type="button"
          aria-label="Back to home"
          onClick={() => navigate("welcome")}
          className="grid h-10 w-10 place-items-center rounded-[10px] text-fg-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
        >
          <House size={16} aria-hidden />
        </button>
      </Tooltip>
      <RailButton
        label="Search tools, effects, or ask AI"
        icon={<Icon name="magnifyingglass" size={16} ariaHidden />}
        onClick={() => openModal("search")}
      />

      <RailDivider />

      {/* ── Group B — Workspace ───────────────────────────────── */}
      <RailButton
        label="Create Motion Scene"
        icon={<Icon name="cube" size={16} ariaHidden />}
        onClick={() => void handleCreateMotionScene()}
      />
      <RailButton
        label="Action history"
        icon={<Icon name="clock" size={16} ariaHidden />}
        onClick={() => openModal("history")}
        active={activeModal === "history"}
      />
      <RailButton
        label="Audio mixer"
        icon={<Icon name="music.note" size={16} ariaHidden />}
        onClick={() => togglePanel("audioMixer")}
        active={Boolean(panels.audioMixer?.visible)}
      />
      <RailButton
        label="AI Editor chat"
        icon={<Icon name="bubble.left.and.text.bubble.right" size={16} ariaHidden />}
        onClick={() => togglePanel("agentChat")}
        active={Boolean(panels.agentChat?.visible)}
      />

      <RailDivider />

      {/* ── Group C — Advanced ────────────────────────────────── */}
      <RailButton
        label="Keyframe editor"
        icon={<Icon name="diamond" size={16} ariaHidden />}
        onClick={toggleKeyframeEditor}
        active={keyframeEditorOpen}
      />
      <RailButton
        label="Project JSON / Comments"
        icon={<Icon name="curlybraces" size={16} ariaHidden />}
        onClick={() => openModal("scriptView")}
      />

      <div className="flex-1" />

      {/* ── Bottom-pinned utilities ───────────────────────────── */}
      <RailButton
        label={themeActionLabel}
        icon={themeIcon}
        onClick={toggleTheme}
      />

      <DropdownMenu
        placement="end"
        button={{
          label: "More editor actions",
          icon: <Settings size={16} aria-hidden />,
          size: "sm",
          variant: "ghost",
          isIconOnly: true,
        }}
        hasChevron={false}
        menuWidth={224}
        items={[
          {
            label: "Settings & API keys",
            icon: <Settings size={14} aria-hidden />,
            onClick: () => openSettings(),
          },
          {
            label: "Screen recorder",
            icon: (
              <Circle
                size={14}
                className="fill-current text-status-error"
                aria-hidden
              />
            ),
            onClick: () => openModal("recorder"),
          },
          { type: "divider" },
          {
            label: "Editor tour",
            icon: <Play size={14} aria-hidden />,
            onClick: () => {
              localStorage.removeItem(ONBOARDING_KEY);
              startTour();
            },
          },
          {
            label: "Animation & effects tour",
            icon: <Sparkles size={14} className="text-accent" aria-hidden />,
            onClick: () => {
              localStorage.removeItem(MOGRAPH_TOUR_KEY);
              startMoGraphTour();
            },
          },
          { type: "divider" },
          {
            label: "Help & shortcuts (press ?)",
            icon: <HelpCircle size={14} aria-hidden />,
            isDisabled: true,
          },
          {
            label: "Project JSON",
            icon: <FileCode size={14} aria-hidden />,
            isDisabled: true,
          },
        ]}
      />
    </nav>
  );
};

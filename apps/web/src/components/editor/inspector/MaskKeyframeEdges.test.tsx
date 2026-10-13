import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BezierPath, Mask, MaskKeyframe } from "@kove-advanced/core";
import { MaskKeyframeEdges } from "./MaskKeyframeEdges";

const box = (): BezierPath => ({
  closed: true,
  points: [
    { x: 0.25, y: 0.25 },
    { x: 0.75, y: 0.25 },
    { x: 0.75, y: 0.75 },
    { x: 0.25, y: 0.75 },
  ],
});

const keyframe = (id: string, time: number, edge: Partial<MaskKeyframe> = {}): MaskKeyframe => ({
  id,
  time,
  path: box(),
  easing: "linear",
  ...edge,
});

const mask = (keyframes: MaskKeyframe[]): Mask => ({
  id: "m1",
  clipId: "c1",
  type: "drawn",
  path: box(),
  feathering: 4,
  expansion: 0,
  inverted: false,
  opacity: 1,
  keyframes,
});

const expand = () => fireEvent.click(screen.getByRole("button", { name: /expand keyframe edges/i }));

afterEach(cleanup);

describe("MaskKeyframeEdges", () => {
  it("has nothing to edit on a mask with no keyframes", () => {
    const { container } = render(
      <MaskKeyframeEdges mask={mask([])} onEdgeChange={() => undefined} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("keeps the editor out of the way until it is expanded", () => {
    render(<MaskKeyframeEdges mask={mask([keyframe("k1", 0)])} onEdgeChange={() => undefined} />);

    expect(screen.queryByLabelText("Keyframe 1 feather px")).toBeNull();
    expand();
    expect(screen.getByLabelText("Keyframe 1 feather px")).toBeTruthy();
  });

  it("writes a hand-set feather to the selected keyframe only", () => {
    const onEdgeChange = vi.fn();
    render(
      <MaskKeyframeEdges
        mask={mask([keyframe("k1", 0, { feathering: 2 }), keyframe("k2", 1)])}
        onEdgeChange={onEdgeChange}
      />,
    );
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Select keyframe 2" }));
    fireEvent.change(screen.getByLabelText("Keyframe 2 feather px"), { target: { value: "12" } });

    expect(onEdgeChange).toHaveBeenCalledWith("k2", { feathering: 12 });
    expect(onEdgeChange).not.toHaveBeenCalledWith("k1", expect.anything());
  });

  it("marks the keyframes that carry an override of their own", () => {
    render(
      <MaskKeyframeEdges
        mask={mask([keyframe("k1", 0, { feathering: 2 }), keyframe("k2", 1)])}
        onEdgeChange={() => undefined}
      />,
    );
    expand();

    expect(screen.getByRole("button", { name: "Select keyframe 1" }).textContent).toContain("•");
    expect(screen.getByRole("button", { name: "Select keyframe 2" }).textContent).not.toContain("•");
  });

  it("resets a keyframe so it inherits the mask's edge again", () => {
    const onEdgeChange = vi.fn();
    render(
      <MaskKeyframeEdges
        mask={mask([keyframe("k1", 0, { feathering: 2, opacity: 0.5 }), keyframe("k2", 1)])}
        onEdgeChange={onEdgeChange}
      />,
    );
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Reset keyframe 1 edge" }));

    expect(onEdgeChange).toHaveBeenCalledWith("k1", {
      feathering: undefined,
      expansion: undefined,
      opacity: undefined,
    });
  });

  it("cannot reset a keyframe that is already inheriting", () => {
    render(
      <MaskKeyframeEdges mask={mask([keyframe("k1", 0)])} onEdgeChange={() => undefined} />,
    );
    expand();

    expect(screen.getByRole("button", { name: "Reset keyframe 1 edge" })).toBeDisabled();
  });

  it("shows the edge blending between two keyframes as you scrub", () => {
    render(
      <MaskKeyframeEdges
        mask={mask([keyframe("k1", 0, { feathering: 2 }), keyframe("k2", 1, { feathering: 10 })])}
        onEdgeChange={() => undefined}
      />,
    );
    expand();

    const scrub = screen.getByLabelText("Scrub edge time");
    fireEvent.change(scrub, { target: { value: "0.5" } });
    const mid = screen.getByText(/· feather/i).textContent ?? "";
    fireEvent.change(scrub, { target: { value: "0.25" } });
    const quarter = screen.getByText(/· feather/i).textContent ?? "";

    // Halfway between 2px and 10px, then a quarter of the way — the preview
    // reads the value the renderer will blend, not either keyframe's own.
    expect(mid).toContain("6.0px");
    expect(quarter).toContain("4.0px");
  });
});

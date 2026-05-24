import { useEffect } from "react";
import { usePipelineStore } from "../store/pipeline";

interface Props {
  x: number;
  y: number;
  nodeId: string;
  onClose: () => void;
}

/**
 * Right-click menu on a canvas node. Currently a single item:
 * "Rerun from here ↻" — kicks off a backend rerun of this node + all
 * downstream nodes in the same plan. Upstream nodes are left alone so
 * their cached mediaId feeds the rerun as input.
 *
 * Closes on outside click, Escape, or after picking an item. Disabled
 * when a pipeline run is already in flight (can't double-run).
 */
export function NodeContextMenu({ x, y, nodeId, onClose }: Props) {
  const rerunFromNode = usePipelineStore((s) => s.rerunFromNode);
  const activeRun = usePipelineStore((s) => s.activeRun);
  const busy = activeRun !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onOutside = (e: MouseEvent) => {
      // mousedown covers both left- and right-click; right-clicking on
      // another node will then reopen the menu at the new location via
      // Board.tsx's onNodeContextMenu after this close fires.
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".node-context-menu")) onClose();
    };
    // Scroll / canvas zoom don't bubble as mousedown — ReactFlow eats the
    // wheel event internally. Close the menu on any wheel so it doesn't
    // float in place while the canvas pans away beneath it.
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".node-context-menu")) return;
      onClose();
    };
    // Capture phase so ReactFlow's internal stopPropagation on its panel
    // can't swallow these events before we see them — the bubble-phase
    // listener (the obvious choice) silently misses canvas pans / wheel
    // zooms entirely. The menu button's own onClick still fires after
    // because we early-return when the target is inside .node-context-menu.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("wheel", onWheel, true);
    };
  }, [onClose]);

  return (
    <div
      // Reuse the .drop-popover skin — same look as the connection-drop
      // popover. Adding .node-context-menu so the outside-click handler
      // can scope itself without colliding with the drop popover's own
      // outside-click handler.
      className="drop-popover node-context-menu"
      style={{ left: x, top: y }}
      role="menu"
      aria-label="Node actions"
    >
      <button
        type="button"
        className="drop-popover__btn"
        disabled={busy}
        title={
          busy
            ? "A pipeline run is already in flight"
            : "Rerun this node and everything downstream"
        }
        onClick={() => {
          if (busy) return;
          void rerunFromNode(Number(nodeId));
          onClose();
        }}
      >
        <span className="drop-popover__icon">↻</span> Rerun from here
      </button>
    </div>
  );
}

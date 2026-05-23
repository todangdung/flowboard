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
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".node-context-menu")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
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

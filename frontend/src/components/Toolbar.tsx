import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBoardStore } from "../store/board";
import { ActivityBell } from "./activity/ActivityBell";
import { AiProviderBadge } from "./AiProviderBadge";
import { SponsorButton } from "./SponsorDialog";

export function Toolbar() {
  const boardName = useBoardStore((s) => s.boardName);
  const nodeCount = useBoardStore((s) => s.nodes.length);
  const autoLayoutBoard = useBoardStore((s) => s.autoLayoutBoard);
  const renameBoard = useBoardStore((s) => s.renameBoard);
  const { fitView } = useReactFlow();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [arranging, setArranging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(boardName);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function commitEdit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== boardName) {
      renameBoard(trimmed);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") inputRef.current?.blur();
    if (e.key === "Escape") {
      setEditing(false);
    }
  }

  const handleAutoLayout = useCallback(async () => {
    if (arranging) return;
    setArranging(true);
    try {
      const changed = await autoLayoutBoard();
      if (changed) {
        requestAnimationFrame(() => {
          fitView({ padding: 0.18, duration: 450, minZoom: 0.1, maxZoom: 1.2 });
        });
      }
    } finally {
      setArranging(false);
    }
  }, [arranging, autoLayoutBoard, fitView]);

  return (
    <div className="toolbar">
      <span className="toolbar-wordmark">Flowboard</span>
      <span className="toolbar-sep" aria-hidden="true">/</span>
      {editing ? (
        <input
          ref={inputRef}
          className="toolbar-name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={onKeyDown}
          aria-label="Board name"
        />
      ) : (
        <button
          className="toolbar-name-btn"
          onClick={startEdit}
          aria-label="Rename board"
          title="Click to rename"
        >
          {boardName || "Untitled"}
        </button>
      )}

      <div className="toolbar-actions">
        <button
          type="button"
          className="toolbar-icon-btn"
          onClick={handleAutoLayout}
          disabled={arranging || nodeCount <= 1}
          aria-label={arranging ? "Arranging nodes" : "Auto arrange nodes"}
          title="Auto arrange nodes"
        >
          <span className="toolbar-auto-layout-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
        <ActivityBell />
        <AiProviderBadge />
        <SponsorButton />
      </div>
    </div>
  );
}


"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, MouseEvent } from "react";

import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  MarkerType,
  SelectionMode,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import {
  createBoardClient,
  type BoardClientState,
  type BoardClient,
} from "@/client/board-client";
import { createHttpBoardTransport } from "@/client/http-board-transport";
import { useIdleHeartbeat } from "@/hooks/useIdleHeartbeat";

type IconProps = {
  size?: number;
  color?: string;
};



function StickyNote({ size = 19, color = "currentColor" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="4"
        stroke={color}
        strokeWidth="1.8"
      />
      <path
        d="M8 15.5H13"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ArrowRight({ size = 19, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12H20M13 5L20 12L13 19" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


function RangeSelect({ size = 19, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="1.5" stroke={color} strokeWidth="1.7" strokeDasharray="3 2" />
      <path d="M8 8H10M8 8V10M16 16H14M16 16V14" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Trash({ size = 19, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7H20M9 7V4H15V7M7 7L8 20H16L17 7M10 10V17M14 10V17" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Smile({ size = 19, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.8" />
      <path d="M8 14.2C8.9 15.5 10.2 16.2 12 16.2C13.8 16.2 15.1 15.5 16 14.2" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="9" cy="9.5" r="1" fill={color} />
      <circle cx="15" cy="9.5" r="1" fill={color} />
    </svg>
  );
}

function Menu({ size = 19, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 6H20M4 12H20M4 18H20" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function Sparkles({ size = 17, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3L13.8 9.2L20 11L13.8 12.8L12 19L10.2 12.8L4 11L10.2 9.2L12 3Z" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M19 15L19.8 17.2L22 18L19.8 18.8L19 21L18.2 18.8L16 18L18.2 17.2L19 15Z" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function MousePointer2({ size = 19, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 3L19 13L12.8 14.1L10 20L5 3Z" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function X({ size = 16, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6L18 18M18 6L6 18" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function Clock3({ size = 16, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.8" />
      <path d="M12 7V12L16 14" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


type NoteKind = "normal" | "related";

// Backend の domain/board.ts と同じデータ形式にする。
type BackendUser = Readonly<{
  userId: string;
}>;

type BackendCardShape = Readonly<{
  height: number;
  width: number;
}>;

type BackendCardPosition = Readonly<{
  x: number;
  y: number;
  z: number;
}>;

type BackendCard = Readonly<{
  cardId: string;
  cardKind: string;
  shape: BackendCardShape;
  position: BackendCardPosition;
  color: string;
  editingUser?: BackendUser;
  text: string;
  reactions: string[];
  relatedIds: string[];
  summary: string;
}>;

type ArrowSide = "top" | "right" | "bottom" | "left";

type BackendArrow = Readonly<{
  arrowId: string;
  sourceCardId: string;
  targetCardId: string;
  sourceSide: ArrowSide | null;
  targetSide: ArrowSide | null;
}>;

// 認証・ユーザー識別の接続後に、最後に編集したユーザーを設定する。
type EditingUser = BackendUser;

type NoteData = {
  // React Flow の node.id とは別に、バックエンド用IDを保持する。
  cardId: string;
  editingUser?: EditingUser;
  // Backend 送受信時に使う変換済みデータ（画面上では派生データ）。
  backendCard?: BackendCard;
  kind: NoteKind;
  title: string;
  summary: string;
  color: string;
  relatedIds: string[];
  reactions: string[];
  onChange?: (id: string, patch: Partial<NoteData>) => void;
  onDropRelated?: (targetId: string, sourceId: string) => void;
  availableNotes?: { id: string; title: string; color: string }[];
  onRemoveRelated?: (targetId: string, sourceId: string) => void;
  onReaction?: (id: string, emoji: string) => void;
  onRemoveReaction?: (id: string, index: number) => void;
  onStartRelatedSelection?: (targetId: string) => void;
  isSelectingRelated?: boolean;
};

type NoteNode = Node<NoteData, "note">;

const COLORS = [
  { name: "黄色", value: "#FFF0A8" },
  { name: "ピンク", value: "#FFDCE5" },
  { name: "青", value: "#D9E9FF" },
  { name: "緑", value: "#DDF5D7" },
  { name: "紫", value: "#EADFFF" },
  { name: "白", value: "#FFFFFF" },
];

const EMOJIS = ["👍", "❤️", "💡", "🤔", "🎉"];

// 付箋のサイズを変えず、文字量に応じて文字サイズを自動調整する
function getAutoFontSize(
  text: string,
  baseSize: number,
  charsPerLine: number,
  maxLines: number
) {
  const lines = text.split("\n").reduce(
    (total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / charsPerLine)),
    0
  );

  if (lines <= maxLines) return baseSize;

  const ratio = Math.sqrt(maxLines / lines);
  return Math.max(8, Math.floor(baseSize * ratio));
}

function NoteCard({ id, data, selected }: NodeProps<NoteNode>) {
  const [showReactions, setShowReactions] = useState(false);

  const relatedNotes = data.relatedIds;

  return (
    <div
      style={{
        width: data.kind === "normal" ? 210 : 290,
        minHeight: 210,
        background: data.color,
        border: selected ? "3px solid #4778e6" : "1px solid #e5dfc9",
        borderRadius: 5,
        boxShadow: selected
          ? "0 0 0 4px #4778e633, 0 8px 24px #00000020"
          : "0 2px 7px #0000000a",
        color: "#292929",
        position: "relative",
        fontFamily: "inherit",
      }}
    >
      <div
        className="drag-handle"
        title="ここをドラッグして付箋を移動"
        style={{
          height: 32,
          margin: "0 3px",
          borderRadius: "4px 4px 0 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "grab",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <div
          style={{
            width: 42,
            height: 5,
            borderRadius: 4,
            background: "#00000025",
          }}
        />
      </div>

      {data.kind === "related" && (
        <div
          style={{
            padding: "9px 12px",
            borderBottom: "1px solid #00000010",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 11,
            color: "#6b6250",
            userSelect: "none",
          }}
        >
          <span>関連カード型</span>
        </div>
      )}

      {data.kind === "normal" ? (
        <textarea
          className="nodrag nowheel"
          value={data.title}
          onChange={(event) =>
            data.onChange?.(id, { title: event.target.value })
          }
          placeholder=""
          style={{
            display: "block",
            width: "100%",
            height: 165,
            resize: "none",
            border: 0,
            outline: 0,
            padding: data.title.trim()
              ? `${Math.max(
                  12,
                  82 -
                    Math.min(data.title.split("\n").length, 6) *
                      getAutoFontSize(data.title, 19, 12, 6) *
                      0.75
                )}px 12px 12px`
              : 12,
            background: "transparent",
            color: "#292929",
            textAlign: "center",
            fontSize: getAutoFontSize(data.title, 19, 12, 6),
            lineHeight: 1.5,
            overflow: "hidden",
            boxSizing: "border-box",
          }}
        />
      ) : (
        <div style={{ padding: 10 }}>
          <div
            style={{
              minHeight: 66,
              padding: 8,
              borderRadius: 5,
              border: "1px dashed #b9b09a",
              background: "#ffffff60",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#6b6250",
                marginBottom: 7,
              }}
            >
              関連カード
            </div>

            {relatedNotes.length === 0 && (
              <div
                style={{
                  fontSize: 11,
                  color: "#817967",
                  textAlign: "center",
                  padding: "9px 2px",
                }}
              >
                ボード上の付箋を選択して追加
              </div>
            )}

            {relatedNotes.map((relatedId) => {
              const related = data.availableNotes?.find(
                (note) => note.id === relatedId
              );

              return (
                <RelatedChip
                  key={relatedId}
                  noteId={relatedId}
                  label={related?.title.trim() || "無題の付箋"}
                  color={related?.color ?? "#ffffff"}
                  targetId={id}
                  remove={data.onRemoveRelated ?? (() => {})}
                />
              );
            })}

            <button
              className="nodrag"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                data.onStartRelatedSelection?.(id);
              }}
              style={{
                width: "100%",
                marginTop: 5,
                padding: "7px 8px",
                border: "1px solid #ded8c8",
                borderRadius: 5,
                background: data.isSelectingRelated
                  ? "#e8efff"
                  : "#ffffffb8",
                color: "#514b3f",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {data.isSelectingRelated
                ? "ボード上の付箋をクリック"
                : "+ ボードから付箋を選択"}
            </button>
          </div>

          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#6b6250",
              margin: "11px 0 5px",
            }}
          >
            概要
          </div>

          <textarea
            className="nodrag nowheel"
            value={data.summary}
            onChange={(event) =>
              data.onChange?.(id, { summary: event.target.value })
            }
            placeholder=""
            style={{
              display: "block",
              width: "100%",
              minHeight: 68,
              resize: "vertical",
              border: 0,
              outline: 0,
              padding: 7,
              borderRadius: 4,
              background: "#ffffff75",
              color: "#292929",
              textAlign: "center",
              fontSize: getAutoFontSize(data.summary, 12, 22, 3),
              lineHeight: 1.4,
              overflow: "hidden",
              boxSizing: "border-box",
            }}
          />
        </div>
      )}

      {data.reactions.length > 0 && (
        <div
          className="nodrag"
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            padding: "0 8px 8px",
          }}
        >
          {data.reactions.map((emoji, index) => (
            <span
              key={`${emoji}-${index}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                borderRadius: 20,
                background: "#ffffffaa",
                padding: "2px 4px 2px 7px",
                fontSize: 13,
              }}
            >
              {emoji}
              <button
                className="nodrag"
                type="button"
                title="このリアクションを削除"
                aria-label={`${emoji}のリアクションを削除`}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onRemoveReaction?.(id, index);
                }}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "#666",
                  cursor: "pointer",
                  padding: "0 2px",
                  lineHeight: 1,
                  fontSize: 13,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className="nodrag"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "0 8px 8px",
          position: "relative",
        }}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setShowReactions(!showReactions);
          }}
          title="リアクション"
          style={smallButton}
        >
          <Smile size={15} />
        </button>

        {showReactions && (
          <div
            style={{
              position: "absolute",
              right: 4,
              bottom: 34,
              zIndex: 20,
              background: "#fff",
              boxShadow: "0 4px 16px #0002",
              borderRadius: 8,
              padding: 5,
              display: "flex",
              gap: 3,
            }}
          >
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  data.onReaction?.(id, emoji);
                  setShowReactions(false);
                }}
                style={{
                  ...smallButton,
                  width: 32,
                  height: 32,
                  fontSize: 17,
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 四辺すべてに接続ハンドルを配置。終点側には矢印を表示 */}
      {(
        [Position.Top, Position.Right, Position.Bottom, Position.Left] as const
      ).map((position) => (
        <Fragment key={position}>
          <Handle
            type="source"
            position={position}
            id={`source-${position}`}
            title="矢印の始点（ドラッグ開始）"
            style={{
              width: 12,
              height: 12,
              background: "#64748b",
              border: "2px solid white",
              boxShadow: "0 0 0 1px #475569",
              zIndex: 5,
              opacity: 1,
            }}
          />
          <Handle
            type="target"
            position={position}
            id={`target-${position}`}
            title="矢印の終点（ここに接続）"
            style={{
              width: 12,
              height: 12,
              background: "#64748b",
              border: "2px solid white",
              boxShadow: "0 0 0 1px #475569",
              zIndex: 4,
              opacity: 1,
            }}
          />
        </Fragment>
      ))}
    </div>
  );
}

function RelatedChip({
  noteId,
  label,
  color,
  targetId,
  remove,
}: {
  noteId: string;
  label: string;
  color: string;
  targetId: string;
  remove: (targetId: string, sourceId: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        background: "#ffffffc9",
        borderRadius: 4,
        padding: "6px 7px",
        marginBottom: 4,
        fontSize: 11,
      }}
    >
      <span style={{ width: 9, height: 9, flexShrink: 0, borderRadius: 2, background: color, border: "1px solid #00000020" }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {label}
      </span>
      <button
        className="nodrag"
        onClick={() => remove(targetId, noteId)}
        title="関連付けを解除"
        style={{ ...smallButton, width: 20, height: 20 }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

// 新規付箋用のバックエンドID。React Flow の node.id とは独立させる。
function createCardId() {
  return `card-${crypto.randomUUID()}`;
}

// React Flow の位置・実測サイズを Backend の Card 形式へ変換する。
// React Flow の node.id と Backend の cardId は別々に保持する。
function toBackendCard(node: NoteNode, allNodes: NoteNode[], z = 0): BackendCard {
  const width = node.measured?.width ?? (node.data.kind === "normal" ? 210 : 290);
  const height = node.measured?.height ?? 210;

  const card: BackendCard = {
    cardId: node.data.cardId,
    cardKind: node.data.kind,
    shape: { width, height },
    position: {
      x: node.position.x,
      y: node.position.y,
      z: node.zIndex ?? z,
    },
    color: node.data.color,
    // Backend の text は単一フィールドなので、normal はタイトル、related は概要を格納。
    // タイトルと概要の両方は summary フィールドも含めて保持する。
    text: node.data.kind === "normal" ? node.data.title : node.data.summary,
    reactions: [...node.data.reactions],
    // Frontend の relatedIds は React Flow の node.id として扱い、
    // Backend へ送る際に cardId へ変換する。
    relatedIds: node.data.relatedIds.map((relatedNodeId) =>
      allNodes.find((candidate) => candidate.id === relatedNodeId)?.data.cardId ?? relatedNodeId
    ),
    summary: node.data.summary,
  };

  if (node.data.editingUser) {
    return { ...card, editingUser: node.data.editingUser };
  }

  return card;
}

function getArrowSide(
  handleId: string | null | undefined,
  prefix: "source" | "target"
): ArrowSide | null {
  if (!handleId?.startsWith(`${prefix}-`)) {
    return null;
  }

  const side = handleId.slice(prefix.length + 1);

  switch (side) {
    case "top":
    case "right":
    case "bottom":
    case "left":
      return side;
    default:
      return null;
  }
}

function toBackendArrow(
  edge: Edge,
  allNodes: NoteNode[]
): BackendArrow | null {
  const sourceNode = allNodes.find(
    (node) => node.id === edge.source
  );

  const targetNode = allNodes.find(
    (node) => node.id === edge.target
  );

  if (!sourceNode || !targetNode) {
    return null;
  }

  return {
    arrowId: edge.id,
    sourceCardId: sourceNode.data.cardId,
    targetCardId: targetNode.data.cardId,
    sourceSide: getArrowSide(edge.sourceHandle, "source"),
    targetSide: getArrowSide(edge.targetHandle, "target"),
  };
}

const nodeTypes = { note: NoteCard };

const initialNotes: NoteNode[] = [
  {
    id: "note-1",
    type: "note",
    dragHandle: ".drag-handle",
    position: { x: 150, y: 120 },
    data: {
      cardId: "card-1",
      kind: "normal",
      title: "ブレストのテーマ",
      summary: "",
      color: "#FFF0A8",
      relatedIds: [],
      reactions: [],
    } as NoteData,
  },
  {
    id: "note-2",
    type: "note",
    dragHandle: ".drag-handle",
    position: { x: 430, y: 120 },
    data: {
      cardId: "card-2",
      kind: "normal",
      title: "利用者の困りごと",
      summary: "",
      color: "#D9E9FF",
      relatedIds: [],
      reactions: [],
    } as NoteData,
  },
  {
    id: "note-3",
    type: "note",
    dragHandle: ".drag-handle",
    position: { x: 700, y: 130 },
    data: {
      cardId: "card-3",
      kind: "related",
      title: "",
      summary: "複数のアイデアをまとめる",
      color: "#DDF5D7",
      relatedIds: [],
      reactions: [],
    } as NoteData,
  },
];

function Board() {
  const { screenToFlowPosition, flowToScreenPosition } = useReactFlow();
  const boardRef = useRef<HTMLDivElement>(null);

  // 案内対象のAI付箋ID
  const [guidedNodeIds, setGuidedNodeIds] = useState<string[]>([]);

  // 画面端に表示する矢印の位置・角度
  const [offscreenArrows, setOffscreenArrows] = useState<
    { id: string; x: number; y: number; angle: number }[]
  >([]);
  const [tool, setTool] = useState<"select" | "range" | "note" | "arrow" | "reaction">(
    "select"
  );
  const [noteKind, setNoteKind] = useState<NoteKind>("normal");
  const [color, setColor] = useState(COLORS[0].value);
  const [showNoteOptions, setShowNoteOptions] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showAIMessage, setShowAIMessage] = useState(false);
  const [aiLevel, setAiLevel] = useState<"low" | "mid" | "high">("mid");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedNodeIds, setGeneratedNodeIds] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(300);
  const [timerRunning, setTimerRunning] = useState(false);
  const [firstArrowNode, setFirstArrowNode] = useState<string | null>(null);
  const [relatedSelectionTarget, setRelatedSelectionTarget] =useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] =
    useNodesState<NoteNode>(initialNotes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const backendArrows = useMemo(
    () =>
      edges
        .map((edge) => toBackendArrow(edge, nodes))
        .filter(
          (arrow): arrow is BackendArrow => arrow !== null
        ),
    [edges, nodes]
  );

  const deleteSelected = useCallback(() => {
    const selectedNodeIds = new Set(
      nodes.filter((node) => node.selected).map((node) => node.id)
    );
    const selectedEdgeIds = new Set(
      edges.filter((edge) => edge.selected).map((edge) => edge.id)
    );

    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;

    setNodes((current) =>
      current.filter((node) => !selectedNodeIds.has(node.id))
    );
    setEdges((current) =>
      current.filter(
        (edge) =>
          !selectedEdgeIds.has(edge.id) &&
          !selectedNodeIds.has(edge.source) &&
          !selectedNodeIds.has(edge.target)
      )
    );
    setFirstArrowNode(null);
  }, [nodes, edges, setNodes, setEdges]);

  const changeNote = useCallback(
    (id: string, patch: Partial<NoteData>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, ...patch } }
            : node
        )
      );
    },
    [setNodes]
  );

  const addRelated = useCallback(
    (targetId: string, sourceId: string) => {
      if (targetId === sourceId) return;

      setNodes((current) =>
        current.map((node) => {
          if (node.id !== targetId) return node;
          if (node.data.relatedIds.includes(sourceId)) return node;
          return {
            ...node,
            data: {
              ...node.data,
              relatedIds: [...node.data.relatedIds, sourceId],
            },
          };
        })
      );
    },
    [setNodes]
  );

  const removeRelated = useCallback(
    (targetId: string, sourceId: string) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === targetId
            ? {
                ...node,
                data: {
                  ...node.data,
                  relatedIds: node.data.relatedIds.filter(
                    (item) => item !== sourceId
                  ),
                },
              }
            : node
        )
      );
    },
    [setNodes]
  );

  const addReaction = useCallback(
    (id: string, emoji: string) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? {
                ...node,
                data: {
                  ...node.data,
                  reactions: [...node.data.reactions, emoji],
                },
              }
            : node
        )
      );
    },
    [setNodes]
  );

  const removeReaction = useCallback(
    (id: string, index: number) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? {
                ...node,
                data: {
                  ...node.data,
                  reactions: node.data.reactions.filter(
                    (_, reactionIndex) => reactionIndex !== index
                  ),
                },
              }
            : node
        )
      );
    },
    [setNodes]
  );

  const wiredNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          backendCard: toBackendCard(node, nodes, nodes.indexOf(node)),
          onChange: changeNote,
          onDropRelated: addRelated,
          availableNotes: nodes
            .filter((candidate) => candidate.data.kind === "normal")
            .map((candidate) => ({
              id: candidate.id,
              title: candidate.data.title,
              color: candidate.data.color,
            })),
          onRemoveRelated: removeRelated,
          onReaction: addReaction,
          onRemoveReaction: removeReaction, // ← ここに追加
          onStartRelatedSelection: setRelatedSelectionTarget,
          isSelectingRelated: relatedSelectionTarget === node.id,
        },
      })),
    [nodes, changeNote, addRelated, removeRelated, addReaction, removeReaction,relatedSelectionTarget]
  );

  const addNoteAt = useCallback(
    (position: { x: number; y: number }) => {
      const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const cardId = createCardId();
      const newNode: NoteNode = {
        id,
        type: "note",
        dragHandle: ".drag-handle",
        position,
        data: {
          cardId,
          kind: noteKind,
          title: "",
          summary: "",
          color,
          relatedIds: [],
          reactions: [],
          onChange: changeNote,
          onDropRelated: addRelated,
          onRemoveRelated: removeRelated,
          onReaction: addReaction,
        },
      };

      setNodes((current) => [...current, newNode]);
      setShowNoteOptions(false);
      setTool("select");
    },
    [
      noteKind,
      color,
      setNodes,
      changeNote,
      addRelated,
      removeRelated,
      addReaction,
    ]
  );

  const generateDummyWords = useCallback(() => {
    const selectedNotes = nodes.filter(
      (node) => node.selected && node.data.kind === "normal"
    );

    // 選択した付箋がなければ、ボード上の通常付箋を使用
    const sourceNotes =
      selectedNotes.length > 0
        ? selectedNotes
        : nodes.filter((node) => node.data.kind === "normal");

    const sourceWords = sourceNotes
      .map((node) => node.data.title.trim())
      .filter(Boolean);

    if (sourceWords.length === 0) {
      window.alert("元になる付箋を1つ以上入力してください。");
      return;
    }

    const dummyWords: Record<"low" | "mid" | "high", string[]> = {
      low: [
        "銀河", "砂漠", "振り子", "深海", "鉱石",
        "惑星", "望遠鏡", "氷河", "化石", "気圧",
      ],
      mid: [
        "快適さ", "インテリア", "音楽", "サービス", "雰囲気",
        "利用者", "デザイン", "価格", "体験", "利便性",
      ],
      high: [
        "課題", "改善案", "利用者の声", "原因", "解決策",
        "具体例", "関連要素", "共通点", "メリット", "工夫",
      ],
    };

    // 同じ生成結果が続きにくいように候補をシャッフル
    const shuffled = [...dummyWords[aiLevel]].sort(
      () => Math.random() - 0.5
    );

    const words = shuffled.slice(0, 1);
    const centerX =
      sourceNotes.reduce((sum, node) => sum + node.position.x, 0) /
      sourceNotes.length;
    const centerY =
      sourceNotes.reduce((sum, node) => sum + node.position.y, 0) /
      sourceNotes.length;

    const newNodes: NoteNode[] = words.map((word, index) => {
      const id = `note-ai-${crypto.randomUUID()}`;

      return {
        id,
        type: "note",
        dragHandle: ".drag-handle",
        position: {
          x: centerX + 280,
          y: centerY + (index - 1) * 230,
        },
        data: {
          cardId: createCardId(),
          kind: "normal",
          title: word,
          summary: `関連性：${
            aiLevel === "low"
              ? "低"
              : aiLevel === "mid"
                ? "中"
                : "高"
          }\n元の単語：${sourceWords.slice(0, 3).join("、")}`,
          color: COLORS[(index + 1) % COLORS.length].value,
          relatedIds: [],
          reactions: [],
        },

      };
    });

    setIsGenerating(true);
    setNodes((current) => [...current, ...newNodes]);

    // 今回生成した付箋を、画面外案内の対象にする
    setGuidedNodeIds((current) => [
      ...current,
      ...newNodes.map((node) => node.id),
    ]);

    setGeneratedNodeIds(newNodes.map((node) => node.id));
    setShowAIMessage(false);

    // 演出状態を一定時間後に解除
    window.setTimeout(() => {
      setGeneratedNodeIds([]);
      setIsGenerating(false);
    }, 900);
  }, [nodes, aiLevel, setNodes]);

  
  useEffect(() => {
    const updateArrows = () => {
      const board = boardRef.current;
      if (!board) return;

      const rect = board.getBoundingClientRect();
      const padding = 38;
      const arrows: {
        id: string;
        x: number;
        y: number;
        angle: number;
      }[] = [];

      const visibleIds: string[] = [];

      for (const id of guidedNodeIds) {
        const node = nodes.find((item) => item.id === id);
        if (!node) continue;

        const width =
          node.measured?.width ??
          (node.data.kind === "normal" ? 210 : 290);
        const height = node.measured?.height ?? 210;

        // 付箋の四隅を画面座標に変換する。
        const topLeft = flowToScreenPosition(node.position);
        const bottomRight = flowToScreenPosition({
          x: node.position.x + width,
          y: node.position.y + height,
        });

        const left = topLeft.x - rect.left;
        const top = topLeft.y - rect.top;
        const right = bottomRight.x - rect.left;
        const bottom = bottomRight.y - rect.top;

        // 付箋全体が画面内に入ったら案内を終了する。
        const isVisible =
          left >= 0 &&
          top >= 0 &&
          right <= rect.width &&
          bottom <= rect.height;

        if (isVisible) {
          visibleIds.push(id);
          continue;
        }

        // 付箋の中心がある方向を求める。
        const x = (left + right) / 2;
        const y = (top + bottom) / 2;
        const dx = x - rect.width / 2;
        const dy = y - rect.height / 2;

        if (dx === 0 && dy === 0) continue;

        // 画面端の少し内側に矢印を配置する。
        const scale = Math.min(
          (rect.width / 2 - padding) / Math.max(Math.abs(dx), 1e-6),
          (rect.height / 2 - padding) / Math.max(Math.abs(dy), 1e-6)
        );

        arrows.push({
          id,
          x: rect.width / 2 + dx * scale,
          y: rect.height / 2 + dy * scale,
          angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        });
      }

      setOffscreenArrows(arrows);

      // 表示範囲に入った付箋は案内対象から外す。
      setGuidedNodeIds((current) => {
        const next = current.filter(
          (id) =>
            !visibleIds.includes(id) &&
            nodes.some((node) => node.id === id)
        );

        // 配列の内容が変わっていなければ、更新しない
        if (
          current.length === next.length &&
          current.every((id, index) => id === next[index])
        ) {
          return current;
        }

        return next;
      });
    };

    updateArrows();

    // ズーム・移動に合わせて矢印を更新する。
    const intervalId = window.setInterval(updateArrows, 100);

    return () => window.clearInterval(intervalId);
  }, [guidedNodeIds, nodes, flowToScreenPosition]);


  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((currentEdges) =>
        addEdge(
          {
            ...connection,
            id: `arrow-${crypto.randomUUID()}`,
            type: "smoothstep",
            markerEnd: {
              type: MarkerType.ArrowClosed,
            },
            style: {
              strokeWidth: 2,
            },
          },
          currentEdges
        )
      );
    },
    [setEdges]
  );

    const onNodeClick = useCallback(
    (_event: MouseEvent, node: NoteNode) => {
      // 関連カードから付箋を選択している場合
      if (relatedSelectionTarget !== null) {
        // 選択元の関連カード自身をクリックした場合は選択解除
        if (node.id === relatedSelectionTarget) {
          setRelatedSelectionTarget(null);
          return;
        }

        // 通常付箋だけを関連付ける
        if (node.data.kind === "normal") {
          addRelated(relatedSelectionTarget, node.id);
          setRelatedSelectionTarget(null);
        }

        return;
      }

      if (tool === "arrow") {
        // 矢印はハンドルからドラッグして作成
        return;
      }

      if (tool === "reaction") {
        addReaction(node.id, "👍");
      }
    },
    [relatedSelectionTarget, addRelated, tool, addReaction]
  );

  const onPaneClick = useCallback(
    (event: MouseEvent) => {
      if (tool !== "note") return;

      // クリックした画面座標をキャンバス座標に変換し、付箋の中央がクリック位置に来るようにする。
      const point = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const noteWidth = noteKind === "normal" ? 190 : 290;
      const noteHeight = noteKind === "normal" ? 190 : 210;

      addNoteAt({
        x: point.x - noteWidth / 2,
        y: point.y - noteHeight / 2,
      });
    },
    [tool, noteKind, screenToFlowPosition, addNoteAt]
  );

  return (
    <div
      ref={boardRef}
      style={{
        height: "100vh",
        width: "100vw",
        background: "#f7f9fc",
        color: "#222",
        fontFamily:
          'Inter, "Noto Sans JP", -apple-system, BlinkMacSystemFont, sans-serif',
        overflow: "hidden",
      }}
    >
      <style>{`
        * { box-sizing: border-box; }
        button { font: inherit; }
        .toolbar-button {
          width: 42px; height: 42px; border: 0; border-radius: 9px;
          background: transparent; color: #555; display: flex;
          align-items: center; justify-content: center; cursor: pointer;
        }
        .toolbar-button:hover { background: #f0f0f0; }
        .toolbar-button.active { background: #e9eefb; color: #355bb5; }
        .nodrag { user-select: text; }
        .drag-handle:active { cursor: grabbing !important; }
        textarea { font-family: inherit; }
        .react-flow__controls { box-shadow: 0 2px 10px #00000010; border: 1px solid #eee; }
        .react-flow__controls-button { border-bottom-color: #eee; }
      `}</style>

      <ReactFlow
        nodes={wiredNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesDraggable={relatedSelectionTarget === null && tool !== "arrow" && tool !== "reaction" && tool !== "range"}
        nodesConnectable={tool === "arrow" || tool === "select"}
        elementsSelectable={tool === "select" || tool === "range"}
        nodesFocusable={tool === "select" || tool === "range"}
        edgesFocusable={tool === "select" || tool === "range"}
        panOnDrag={tool !== "range"}
        selectionOnDrag={tool === "range"}
        selectionMode={SelectionMode.Partial}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
        defaultEdgeOptions={{
          type: "smoothstep",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 22,
            height: 22,
            color: "#334155",
          },
        }}
        style={{ background: "#f7f9fc" }}
      >
        <Background variant={BackgroundVariant.Lines} color="#dce2eb" gap={30} size={1} />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>

      {/* 画面外にあるAI付箋への案内矢印 */}
      {offscreenArrows.map((arrow) => (
        <div
          key={arrow.id}
          title="この方向にAI生成付箋があります"
          style={{
            position: "absolute",
            zIndex: 15,
            left: arrow.x,
            top: arrow.y,
            transform: `translate(-50%, -50%) rotate(${arrow.angle}deg)`,
            width: 42,
            height: 42,
            borderRadius: "50%",
            background: "#2563eb",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 3px 12px #00000030",
            pointerEvents: "none",
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M5 12H19M12 5L19 12L12 19"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      ))}

      {/* 左ツールバー */}
      <div
        style={{
          position: "absolute",
          zIndex: 10,
          top: "50%",
          left: 18,
          transform: "translateY(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          padding: 7,
          background: "#fff",
          border: "1px solid #ececec",
          borderRadius: 13,
          boxShadow: "0 3px 16px #0000000c",
        }}
      >
        <button
          className={`toolbar-button ${tool === "select" ? "active" : ""}`}
          title="選択・移動"
          onClick={() => {
            setTool("select");
            setFirstArrowNode(null);
          }}
        >
          <MousePointer2 size={19} />
        </button>
        <button
          className={`toolbar-button ${tool === "range" ? "active" : ""}`}
          title="範囲選択"
          onClick={() => {
            setTool("range");
            setFirstArrowNode(null);
            setShowNoteOptions(false);
          }}
        >
          <RangeSelect size={19} />
        </button>
        <div style={separator} />
        <button
          className={`toolbar-button ${tool === "note" ? "active" : ""}`}
          title="付箋を追加"
          onClick={() => {
            setTool("note");
            setShowNoteOptions(!showNoteOptions);
            setFirstArrowNode(null);
          }}
        >
          <StickyNote size={19} />
        </button>
        <button
          className={`toolbar-button ${tool === "arrow" ? "active" : ""}`}
          title="矢印で接続"
          onClick={() => {
            setTool("arrow");
            setFirstArrowNode(null);
            setShowNoteOptions(false);
          }}
        >
          <ArrowRight size={19} />
        </button>
        <button
          className={`toolbar-button ${tool === "reaction" ? "active" : ""}`}
          title="付箋にリアクション"
          onClick={() => {
            setTool("reaction");
            setShowNoteOptions(false);
            setFirstArrowNode(null);
          }}
        >
          <Smile size={19} />
        </button>
        <div style={separator} />
        <button
          className="toolbar-button"
          title="選択した付箋・矢印を削除"
          onClick={deleteSelected}
        >
          <Trash size={19} />
        </button>
      </div>

      {/* 付箋の種類と色 */}
      {showNoteOptions && (
        <div
          style={{
            position: "absolute",
            zIndex: 20,
            top: "50%",
            left: 78,
            transform: "translateY(-50%)",
            width: 224,
            background: "#fff",
            border: "1px solid #e8e8e8",
            borderRadius: 12,
            padding: 14,
            boxShadow: "0 8px 28px #00000012",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <strong style={{ fontSize: 13 }}>付箋を追加</strong>
            <button
              onClick={() => setShowNoteOptions(false)}
              style={smallButton}
            >
              <X size={16} />
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {(
              [
                ["normal", "通常付箋"],
                ["related", "関連カード型"],
              ] as [NoteKind, string][]
            ).map(([kind, label]) => (
              <button
                key={kind}
                onClick={() => setNoteKind(kind)}
                style={{
                  flex: 1,
                  padding: "9px 5px",
                  fontSize: 11,
                  borderRadius: 7,
                  border:
                    noteKind === kind
                      ? "1px solid #6a80b8"
                      : "1px solid #e5e5e5",
                  background: noteKind === kind ? "#eef2ff" : "#fff",
                  color: "#333",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#777", marginBottom: 8 }}>
            付箋の色
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {COLORS.map((item) => (
              <button
                key={item.value}
                title={item.name}
                onClick={() => setColor(item.value)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  border:
                    color === item.value
                      ? "2px solid #555"
                      : "1px solid #ddd",
                  background: item.value,
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
          <button
            onClick={() => {
              setTool("note");
              setShowNoteOptions(false);
            }}
            style={{
              width: "100%",
              marginTop: 15,
              border: 0,
              borderRadius: 7,
              padding: 10,
              background: "#252525",
              color: "#fff",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            キャンバスをクリックして配置
          </button>
        </div>
      )}

      {/* 右上：タイマーとメニュー */}
      <div
        style={{
          position: "absolute",
          zIndex: 10,
          top: 16,
          right: 18,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            border: "1px solid #eee",
            borderRadius: 9,
            background: "#fff",
            boxShadow: "0 2px 8px #00000008",
          }}
        >
          <Clock3 size={16} color="#666" />
          <strong
            style={{
              fontVariantNumeric: "tabular-nums",
              fontSize: 14,
              minWidth: 43,
            }}
          >
            {Math.floor(seconds / 60)
              .toString()
              .padStart(2, "0")}
            :{(seconds % 60).toString().padStart(2, "0")}
          </strong>
          <button
            onClick={() => setTimerRunning(!timerRunning)}
            style={smallButton}
          >
            {timerRunning ? "停止" : "開始"}
          </button>
          <button onClick={() => setSeconds(300)} style={smallButton}>
            リセット
          </button>
        </div>
        <button
          onClick={() => setShowMenu(!showMenu)}
          style={{
            width: 40,
            height: 40,
            border: "1px solid #eee",
            background: "#fff",
            borderRadius: 9,
            cursor: "pointer",
          }}
          title="メニュー"
        >
          <Menu size={19} />
        </button>
        {showMenu && (
          <div
            style={{
              position: "absolute",
              top: 48,
              right: 0,
              width: 175,
              padding: 8,
              border: "1px solid #eee",
              borderRadius: 10,
              background: "#fff",
              boxShadow: "0 5px 18px #00000012",
            }}
          >
            <button
              onClick={() => {
                setNodes([]);
                setEdges([]);
                setShowMenu(false);
              }}
              style={menuItem}
            >
              キャンバスをクリア
            </button>
            <button
              onClick={() => {
                setNodes(initialNotes);
                setEdges([]);
                setShowMenu(false);
              }}
              style={menuItem}
            >
              サンプルに戻す
            </button>
          </div>
        )}
      </div>

      
      {/* 操作ガイド */}
      {(tool === "arrow" ||
        tool === "note" ||
        tool === "reaction" ||
        relatedSelectionTarget !== null) && (
        <div
          style={{
            position: "absolute",
            zIndex: 10,
            top: 18,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#fff",
            border: "1px solid #eee",
            boxShadow: "0 2px 10px #00000008",
            padding: "9px 15px",
            borderRadius: 9,
            fontSize: 12,
            color: "#555",
            pointerEvents: "none",
          }}
        >
          {relatedSelectionTarget !== null &&
            "関連付け先を選択中：ボード上の通常付箋をクリック"}

          {relatedSelectionTarget === null && tool === "note" &&
            "キャンバスをクリックして付箋を配置"}

          {relatedSelectionTarget === null && tool === "arrow" &&
            "青い点（始点）から赤い点（終点）へドラッグして矢印を作成"}

          {relatedSelectionTarget === null && tool === "reaction" &&
            "リアクションを付けたい付箋をクリック"}
        </div>
      )}


      {/* 右下：AIボタンのみ */}
      <button
        onClick={() => setShowAIMessage((current) => !current)}
        style={{
          position: "absolute",
          zIndex: 10,
          bottom: 22,
          right: 22,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 17px",
          border: 0,
          borderRadius: 12,
          background: "#252525",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          boxShadow: "0 4px 16px #0000001c",
          cursor: "pointer",
        }}
      >
        <Sparkles size={17} />
        AI
      </button>

      {showAIMessage && (
        <div
          style={{
            position: "absolute",
            zIndex: 30,
            right: 22,
            bottom: 82,
            width: 270,
            padding: 16,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            boxShadow: "0 8px 28px #00000018",
            color: "#333",
            fontSize: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <strong style={{ fontSize: 14 }}>関連語を生成</strong>
            <button
              type="button"
              onClick={() => setShowAIMessage(false)}
              style={smallButton}
              aria-label="閉じる"
            >
              <X size={16} />
            </button>
          </div>

          <div style={{ color: "#777", marginBottom: 10 }}>
            関連性の度合い
          </div>

          {(
            [
              ["low", "低", "元の単語から遠い"],
              ["mid", "中", "同じジャンルの関連語"],
              ["high", "高", "強く関連する単語"],
            ] as const
          ).map(([value, label, description]) => (
            <button
              key={value}
              type="button"
              onClick={() => setAiLevel(value)}
              style={{
                display: "block",
                width: "100%",
                padding: "10px",
                marginBottom: 6,
                textAlign: "left",
                borderRadius: 8,
                border:
                  aiLevel === value
                    ? "1px solid #6b82c5"
                    : "1px solid #e5e7eb",
                background: aiLevel === value ? "#eef2ff" : "#fff",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 3 }}>
                {label}
              </div>
              <div style={{ fontSize: 11, color: "#777" }}>
                {description}
              </div>
            </button>
          ))}

          <button
            type="button"
            disabled={isGenerating}
            onClick={generateDummyWords}
            style={{
              width: "100%",
              marginTop: 8,
              padding: 11,
              border: 0,
              borderRadius: 8,
              background: isGenerating ? "#888" : "#252525",
              color: "#fff",
              cursor: isGenerating ? "wait" : "pointer",
              fontWeight: 600,
            }}
          >
            {isGenerating ? "生成中..." : "単語を生成"}
          </button>

          <div
            style={{
              marginTop: 9,
              color: "#999",
              fontSize: 10,
              lineHeight: 1.5,
            }}
          >
            現在はダミーデータを使用しています。
          </div>
        </div>
      )}

      {(tool === "select" || tool === "range") && (
        <div
          style={{
            position: "absolute",
            zIndex: 5,
            bottom: 18,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            color: "#aaa",
            pointerEvents: "none",
          }}
        >
          {tool === "range" ? "ドラッグで範囲選択 · 選択後はゴミ箱で削除" : "ドラッグで移動 · ホイールでズーム"}
        </div>
      )}
    </div>
  );
}

const smallButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: 0,
  background: "transparent",
  borderRadius: 5,
  cursor: "pointer",
  color: "#555",
  padding: 4,
};

const separator: CSSProperties = {
  width: 25,
  height: 1,
  background: "#eee",
  margin: "2px 0",
};

const menuItem: CSSProperties = {
  width: "100%",
  textAlign: "left",
  padding: "10px 9px",
  background: "#fff",
  border: 0,
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

export default function Home() {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  );
}